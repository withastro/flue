/**
 * pr-redirect — redirect non-maintainer PRs into issues or discussions.
 *
 * Invoked from `.github/workflows/pr-redirect.yml` as a one-shot CLI run.
 * No HTTP trigger.
 *
 * Pipeline
 * --------
 *   1. LLM phase (uses `gh` inside the sandbox with read-only GITHUB_TOKEN):
 *        - fetch PR details
 *        - classify as 'bug' or 'feature' (when ambiguous: 'bug')
 *        - generate search queries and look up open issues/discussions
 *        - score candidates; high/medium-confidence match = duplicate
 *   2. Deterministic phase (plain TS, FREDKBOT_GITHUB_TOKEN):
 *        - duplicate found → comment on existing thread, close PR
 *        - otherwise        → create new issue/discussion, close PR
 *
 * Security
 * --------
 * The sandbox env is an allowlist; `FREDKBOT_GITHUB_TOKEN` is never
 * exposed to it, so even total prompt injection of the LLM phase cannot
 * make `astrobot-houston` write anything. All mutations happen in the
 * deterministic phase from typed inputs validated by the agent.
 *
 * If you change the `local({ env })` call below, re-read this paragraph
 * before adding any secret to the sandbox.
 */

import { defineAgent, defineWorkflow, type FlueSession } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';
import {
	closePullRequest,
	commentOnDiscussion,
	commentOnIssue,
	commentOnPullRequest,
	createDiscussion,
	createIssue,
	removeLabelIfPresent,
} from '../lib/github.ts';

// Subset of FlueLogger; declared locally so helpers can take a logger
// without passing the whole execution context through every signature.
type Logger = {
	info: (msg: string, attrs?: Record<string, unknown>) => void;
	warn: (msg: string, attrs?: Record<string, unknown>) => void;
	error: (msg: string, attrs?: Record<string, unknown>) => void;
};

const FEATURE_REQUEST_CATEGORY = 'Feature Request';

// Label that, when added to a PR, manually triggers this workflow. The
// workflow listens for `pull_request_target` with `action: labeled`
// filtered to this name. The agent removes it on success so re-adding
// it re-runs the workflow.
const TRIAGE_LABEL = 'triage';

// ─── Types ──────────────────────────────────────────────────────────────────

interface PrDetails {
	number: number;
	title: string;
	body: string;
	author: string;
	headRefName: string;
	headRepoFullName: string;
	htmlUrl: string;
	baseRepo: string;
	filesChanged: number;
	diffStat: string;
}

type Classification = {
	kind: 'bug' | 'feature';
	suggestedTitle: string;
	summary: string;
};

type DuplicateMatch = {
	kind: 'issue' | 'discussion';
	number: number;
	url: string;
	title: string;
	confidence: 'high' | 'medium' | 'low';
};

type Decision =
	| { action: 'create-issue'; title: string; body: string }
	| { action: 'create-discussion'; title: string; body: string }
	| {
			action: 'comment-on-duplicate';
			duplicate: DuplicateMatch;
			commentBody: string;
	  };

// ─── Step 0: fetch PR via `gh` ──────────────────────────────────────────────

async function fetchPullRequest(session: FlueSession, prNumber: number): Promise<PrDetails> {
	// `gh pr view --json` returns structured data, so PR-controlled
	// strings (title, body, branch name) never reach a shell parser.
	const fields =
		'number,title,body,author,headRefName,headRepository,headRepositoryOwner,url,baseRefName,files,changedFiles';
	const result = await session.shell(`gh pr view ${prNumber} --json ${fields}`);
	if (result.exitCode !== 0) {
		throw new Error(`gh pr view ${prNumber} failed: ${result.stderr}`);
	}
	const raw = JSON.parse(result.stdout) as {
		number: number;
		title: string;
		body: string;
		author: { login: string };
		headRefName: string;
		headRepository: { name: string };
		headRepositoryOwner: { login: string };
		url: string;
		files: Array<{ path: string; additions: number; deletions: number }>;
		changedFiles: number;
	};
	const headOwner = raw.headRepositoryOwner.login;
	const headName = raw.headRepository.name;
	const baseRepo = process.env.GITHUB_REPOSITORY ?? 'withastro/flue';
	const diffStat = raw.files
		.slice(0, 25)
		.map((f) => `- \`${f.path}\` (+${f.additions} / -${f.deletions})`)
		.join('\n');
	return {
		number: raw.number,
		title: raw.title,
		body: raw.body ?? '',
		author: raw.author.login,
		headRefName: raw.headRefName,
		headRepoFullName: `${headOwner}/${headName}`,
		htmlUrl: raw.url,
		baseRepo,
		filesChanged: raw.changedFiles,
		diffStat,
	};
}

// ─── Step 1: classify ───────────────────────────────────────────────────────

async function classify(session: FlueSession, pr: PrDetails): Promise<Classification> {
	const prompt = `You are triaging a GitHub pull request to a TypeScript framework. Decide whether it's:
- a **bug** fix (addresses incorrect or broken behavior), or
- a **feature** (adds new functionality, enhances existing behavior, refactors APIs).

If unsure or it could be either, choose **bug**.

## PR
**Title:** ${pr.title}
**Author:** @${pr.author}
**Files changed (${pr.filesChanged}):**
${pr.diffStat || '(no files listed)'}

**Body:**
${pr.body || '(empty)'}

## Output
Return ONLY a JSON object on a single line, no markdown fences:
{"kind": "bug" | "feature", "suggestedTitle": "<concise title for the resulting issue/discussion>", "summary": "<1-3 sentence summary of what the PR does, in your own words>"}

The suggestedTitle should be problem-focused for bugs ("X crashes when Y") and proposal-focused for features ("Support X in Y"). Strip any "feat:" / "fix:" prefixes.`;

	const response = await session.prompt(prompt);
	const parsed = extractJson(response.text);
	if (
		typeof parsed !== 'object' ||
		parsed === null ||
		!('kind' in parsed) ||
		!('suggestedTitle' in parsed) ||
		!('summary' in parsed)
	) {
		throw new Error(`Classification response missing required fields: ${response.text}`);
	}
	const kind = (parsed as { kind: unknown }).kind;
	const suggestedTitle = (parsed as { suggestedTitle: unknown }).suggestedTitle;
	const summary = (parsed as { summary: unknown }).summary;
	if (kind !== 'bug' && kind !== 'feature') {
		throw new Error(`Invalid kind in classification: ${String(kind)}`);
	}
	if (typeof suggestedTitle !== 'string' || typeof summary !== 'string') {
		throw new Error(`Classification fields must be strings: ${response.text}`);
	}
	return { kind, suggestedTitle, summary };
}

// ─── Step 2 & 3: duplicate search ───────────────────────────────────────────

interface Candidate {
	kind: 'issue' | 'discussion';
	number: number;
	title: string;
	url: string;
	excerpt: string;
}

async function generateSearchQueries(
	session: FlueSession,
	pr: PrDetails,
	classification: Classification,
): Promise<string[]> {
	const prompt = `Generate 2 GitHub search queries to find existing open issues or discussions that may already cover this PR. Use specific keywords from the title and summary. Avoid generic terms like "bug" or "feature".

PR title: ${pr.title}
Summary: ${classification.summary}

Return ONLY a JSON array of 2 strings on a single line, no markdown fences:
["query 1 with specific keywords", "query 2 with different angle"]

Each query should be 2-5 words, no quotes inside, no special GitHub search qualifiers.`;
	const response = await session.prompt(prompt);
	const parsed = extractJson(response.text);
	if (!Array.isArray(parsed)) {
		throw new Error(`Expected JSON array of search queries: ${response.text}`);
	}
	const queries = parsed.filter((q): q is string => typeof q === 'string' && q.trim().length > 0);
	if (queries.length === 0) {
		// Fall back to the PR title so the dup search still runs.
		return [pr.title];
	}
	return queries.slice(0, 3);
}

/**
 * Quote a string for safe inclusion inside POSIX single-quoted shell
 * arguments. Required because we interpolate LLM-generated and PR-derived
 * strings into `gh` shell commands.
 */
function shellEscape(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

async function searchIssues(
	session: FlueSession,
	log: Logger,
	repo: string,
	query: string,
): Promise<Candidate[]> {
	// `gh search issues` adds a `type:issue` qualifier internally, so PRs
	// are excluded from results without us needing to filter.
	const cmd = `gh search issues --repo ${shellEscape(repo)} --state open --limit 10 ${shellEscape(
		query,
	)} --json number,title,url,body`;
	const result = await session.shell(cmd);
	if (result.exitCode !== 0) {
		// Search failures shouldn't crash the pipeline — log and move on.
		log.warn('gh search issues failed', { query, stderr: result.stderr });
		return [];
	}
	const raw = JSON.parse(result.stdout) as Array<{
		number: number;
		title: string;
		url: string;
		body: string;
	}>;
	return raw.map((r) => ({
		kind: 'issue' as const,
		number: r.number,
		title: r.title,
		url: r.url,
		excerpt: (r.body ?? '').slice(0, 240).replace(/\s+/g, ' ').trim(),
	}));
}

async function searchDiscussions(
	session: FlueSession,
	log: Logger,
	repo: string,
	query: string,
): Promise<Candidate[]> {
	// `gh search discussions` does not exist; use GraphQL via `gh api graphql`.
	const ghQuery = `repo:${repo} is:open ${query}`;
	const graphql = `query($q: String!) {
		search(type: DISCUSSION, query: $q, first: 10) {
			nodes {
				... on Discussion { number title url body }
			}
		}
	}`;
	const cmd = `gh api graphql -f query=${shellEscape(graphql)} -f q=${shellEscape(ghQuery)}`;
	const result = await session.shell(cmd);
	if (result.exitCode !== 0) {
		log.warn('gh api graphql (discussion search) failed', { query, stderr: result.stderr });
		return [];
	}
	const raw = JSON.parse(result.stdout) as {
		data?: {
			search?: { nodes?: Array<{ number?: number; title?: string; url?: string; body?: string }> };
		};
	};
	const nodes = raw.data?.search?.nodes ?? [];
	return nodes
		.filter(
			(n): n is { number: number; title: string; url: string; body?: string } =>
				typeof n.number === 'number' && typeof n.title === 'string' && typeof n.url === 'string',
		)
		.map((n) => ({
			kind: 'discussion' as const,
			number: n.number,
			title: n.title,
			url: n.url,
			excerpt: (n.body ?? '').slice(0, 240).replace(/\s+/g, ' ').trim(),
		}));
}

async function scoreDuplicates(
	session: FlueSession,
	log: Logger,
	pr: PrDetails,
	classification: Classification,
	candidates: Candidate[],
): Promise<DuplicateMatch | null> {
	if (candidates.length === 0) return null;

	// Dedupe by (kind, number) — different queries can surface the same item.
	const seen = new Map<string, Candidate>();
	for (const c of candidates) {
		seen.set(`${c.kind}#${c.number}`, c);
	}
	const unique = [...seen.values()];

	const candidateList = unique
		.map(
			(c, i) =>
				`${i + 1}. [${c.kind} #${c.number}] ${c.title}\n   ${c.url}\n   ${c.excerpt || '(no body excerpt)'}`,
		)
		.join('\n\n');

	const prompt = `Decide whether any of the candidate open issues/discussions below is the SAME problem or proposal as this PR. Be strict: only flag a duplicate if it clearly describes the same bug or the same feature request.

## PR (${classification.kind})
**Title:** ${pr.title}
**Summary:** ${classification.summary}

## Candidates
${candidateList}

## Output
Return ONLY a JSON object on a single line, no markdown fences:
{"duplicate": null} — if none are clearly the same.
{"duplicate": {"index": <1-based number from the list>, "confidence": "high" | "medium" | "low"}} — if one matches.

Guidance:
- "high" = same bug/feature, near-certain.
- "medium" = likely the same but the descriptions differ enough to leave room for doubt.
- "low" = related but probably distinct.

If multiple candidates match, pick the most relevant one only.`;

	const response = await session.prompt(prompt);
	const parsed = extractJson(response.text);
	if (typeof parsed !== 'object' || parsed === null) {
		log.warn('duplicate scorer returned non-object, treating as no dup', { text: response.text });
		return null;
	}
	const dup = (parsed as { duplicate?: unknown }).duplicate;
	if (dup === null || dup === undefined) return null;
	if (typeof dup !== 'object') return null;
	const index = (dup as { index?: unknown }).index;
	const confidence = (dup as { confidence?: unknown }).confidence;
	if (typeof index !== 'number' || index < 1 || index > unique.length) return null;
	if (confidence !== 'high' && confidence !== 'medium' && confidence !== 'low') return null;
	// Low confidence is treated as "no duplicate" — we'd rather create a
	// new thread that a human can merge later than wrongly attach a
	// contributor's branch to an unrelated issue.
	if (confidence === 'low') return null;
	const picked = unique[index - 1];
	if (!picked) return null;
	return {
		kind: picked.kind,
		number: picked.number,
		url: picked.url,
		title: picked.title,
		confidence,
	};
}

// ─── Body composition ───────────────────────────────────────────────────────

const BRANCH_URL = (pr: PrDetails) =>
	`https://github.com/${pr.headRepoFullName}/tree/${pr.headRefName}`;
const COMPARE_URL = (pr: PrDetails) =>
	`https://github.com/${pr.baseRepo}/compare/main...${pr.headRepoFullName.replace('/', ':')}:${pr.headRefName}`;

/** One-line attribution back to the source PR. */
function originalImplementationLine(pr: PrDetails): string {
	return `Original implementation from [#${pr.number}](${pr.htmlUrl}) by @${pr.author}`;
}

/**
 * Banner reproduced verbatim at the top of every auto-created issue and
 * discussion. Names the source PR and explains the redirect model:
 * ideas get discussed first, implementation follows once the idea is
 * prioritized.
 */
type BannerLead =
	| 'verbatim' // discussion: full PR body follows, unmodified
	| 'rephrased'; // bug issue: body was rewritten by the LLM into the bug template

function redirectBanner(pr: PrDetails, lead: BannerLead): string {
	const firstLine =
		lead === 'verbatim'
			? `_Originally proposed by @${pr.author} in [#${pr.number}](${pr.htmlUrl}). Their description is reproduced verbatim below._`
			: `_Originally reported by @${pr.author} in [#${pr.number}](${pr.htmlUrl})._`;
	return `> ${firstLine}
>
> _All community-submitted pull requests are automatically converted to issues (bugs) & discussions (feature requests, enhancements) where they can be triaged and prioritized. Once prioritized, a PR implementation is created automatically._`;
}

/**
 * The bug-report template that the LLM is asked to fill in. Kept inline
 * (not read from `.github/ISSUE_TEMPLATE/01-bug-report.md`) so the prompt
 * is self-contained and not affected by template edits at runtime.
 *
 * If the on-disk template changes meaningfully, update this string to
 * match.
 */
const BUG_REPORT_TEMPLATE = `### Describe the Bug

<!-- A clear and concise description of what the bug is. -->

### Expected Behavior

<!-- What did you expect to happen instead? -->

### Steps to Reproduce

<!-- Either starting from one of the examples in \`examples/\`, or from a basic hello world. -->

1.
2.
3.`;

/**
 * Ask the LLM to map the PR's content onto the bug-report template,
 * returning a complete markdown body. Output is used verbatim — we
 * trust the model to produce well-formed markdown that follows the
 * shape of the template.
 */
async function writeBugIssueBody(session: FlueSession, pr: PrDetails): Promise<string> {
	const prompt = `A contributor opened a pull request fixing what they believe is a bug. Translate their PR into a bug-report issue body that follows the template below.

Fill each section based on what the PR title, body, and changed files imply. If a section is genuinely impossible to infer (for example, no reproduction steps are mentioned anywhere), leave its placeholder text in place so a maintainer can fill it in later. Do not invent reproduction steps you can't justify from the PR's content.

## PR
**Title:** ${pr.title}
**Author:** @${pr.author}
**Files changed (${pr.filesChanged}):**
${pr.diffStat || '(no files listed)'}

**Body:**
${pr.body || '(empty)'}

## Template to fill
${BUG_REPORT_TEMPLATE}

## Output
Return only the filled-in markdown body. No JSON, no fences, no explanation. Start directly with the first \`###\` heading. Do not add a top-level title — the issue title is set separately.`;
	const response = await session.prompt(prompt);
	return response.text.trim();
}

function bugIssueBody(pr: PrDetails, llmBody: string): string {
	return `${redirectBanner(pr, 'rephrased')}

${llmBody}

---

${originalImplementationLine(pr)}`;
}

function featureDiscussionBody(pr: PrDetails): string {
	// Verbatim PR body with attribution. Features are typically already
	// justifying themselves in prose, so the original wording is the
	// most useful starting point for discussion. The body is included
	// raw (not block-quoted) so that fenced code blocks, mermaid
	// diagrams, headings, etc. render natively.
	const body = pr.body?.trim() || '_(no description)_';
	return `${redirectBanner(pr, 'verbatim')}

${body}

---

${originalImplementationLine(pr)}`;
}

function duplicateCommentBody(pr: PrDetails, classification: Classification): string {
	return `**Possibly related contribution from @${pr.author}** — opened ${pr.htmlUrl} which appears to be addressing this.

**Their summary:** ${classification.summary}

**Implementation:** [${pr.headRepoFullName}@${pr.headRefName}](${BRANCH_URL(pr)}) ([diff](${COMPARE_URL(pr)}))

_This comment was posted automatically when #${pr.number} was redirected. The implementation is preserved on the branch above so it can inform the work here._`;
}

function closePrComment(
	destinationUrl: string,
	kind: 'issue' | 'discussion' | 'duplicate',
): string {
	const where =
		kind === 'duplicate'
			? `existing thread: ${destinationUrl}`
			: kind === 'issue'
				? `issue: ${destinationUrl}`
				: `discussion: ${destinationUrl}`;
	return `Thanks for the contribution! We're closing this PR and moving the conversation to the ${where}

We've moved to a model where bugs and feature proposals are discussed in issues/discussions before code review, so the community can help prioritize and shape the work. Your branch is linked from the new thread so the implementation isn't lost — please join us there to continue the conversation.

— astrobot 🤖`;
}

// ─── Misc ───────────────────────────────────────────────────────────────────

/**
 * Parse a JSON value out of an LLM response. Models occasionally wrap
 * JSON in markdown fences or surrounding prose despite explicit
 * instructions; this finds the first balanced `{...}` or `[...]` and
 * parses that.
 */
function extractJson(text: string): unknown {
	const stripped = text
		.replace(/^\s*```(?:json)?\s*/i, '')
		.replace(/\s*```\s*$/i, '')
		.trim();
	// Fast path: whole thing is JSON.
	try {
		return JSON.parse(stripped);
	} catch {
		// Fall through.
	}
	// Find first { or [ and parse from there using bracket counting.
	for (let i = 0; i < stripped.length; i++) {
		const ch = stripped[i];
		if (ch !== '{' && ch !== '[') continue;
		const open = ch;
		const close = ch === '{' ? '}' : ']';
		let depth = 0;
		let inString = false;
		let escaped = false;
		for (let j = i; j < stripped.length; j++) {
			const c = stripped[j];
			if (escaped) {
				escaped = false;
				continue;
			}
			if (c === '\\') {
				escaped = true;
				continue;
			}
			if (c === '"') inString = !inString;
			if (inString) continue;
			if (c === open) depth++;
			else if (c === close) {
				depth--;
				if (depth === 0) {
					try {
						return JSON.parse(stripped.slice(i, j + 1));
					} catch {
						break;
					}
				}
			}
		}
	}
	throw new Error(`Could not parse JSON from model response: ${text}`);
}

// ─── Entry point ────────────────────────────────────────────────────────────

const ghToken = process.env.GITHUB_TOKEN;
const agent = defineAgent(() => {
	if (!ghToken) throw new Error('GITHUB_TOKEN env var is required.');
	return {
		sandbox: local({ env: { GH_TOKEN: ghToken } }),
		model: 'anthropic/claude-opus-4-6',
	};
});

export default defineWorkflow({
	agent,
	input: v.object({ prNumber: v.pipe(v.number(), v.integer()) }),
	async run({ harness, input, log }) {
		const { prNumber } = input;

		// Validate the privileged token before spending LLM tokens. It remains
		// outside the sandbox allowlist and is read only by lib/github.ts.
		if (!process.env.FREDKBOT_GITHUB_TOKEN) {
			throw new Error('FREDKBOT_GITHUB_TOKEN env var is required.');
		}

		const session = await harness.session();

		// ─── LLM phase ──────────────────────────────────────────────────────
		const pr = await fetchPullRequest(session, prNumber);
		log.info('pr-redirect: fetched PR', { prNumber, author: pr.author, title: pr.title });

		const classification = await classify(session, pr);
		log.info('pr-redirect: classified', {
			prNumber,
			kind: classification.kind,
			suggestedTitle: classification.suggestedTitle,
		});

		const queries = await generateSearchQueries(session, pr, classification);
		log.info('pr-redirect: search queries', { prNumber, queries });

		const allCandidates: Candidate[] = [];
		for (const q of queries) {
			const results =
				classification.kind === 'bug'
					? await searchIssues(session, log, pr.baseRepo, q)
					: await searchDiscussions(session, log, pr.baseRepo, q);
			allCandidates.push(...results);
		}
		log.info('pr-redirect: candidates', { prNumber, count: allCandidates.length });

		const duplicate = await scoreDuplicates(session, log, pr, classification, allCandidates);
		if (duplicate) {
			log.info('pr-redirect: duplicate found', {
				prNumber,
				duplicateNumber: duplicate.number,
				confidence: duplicate.confidence,
			});
		} else {
			log.info('pr-redirect: no duplicate', { prNumber });
		}

		// ─── Build the Decision ─────────────────────────────────────────────
		// Pure data and a final LLM call (only for bugs). No mutations
		// happen until the switch below.
		let decision: Decision;
		if (duplicate) {
			decision = {
				action: 'comment-on-duplicate',
				duplicate,
				commentBody: duplicateCommentBody(pr, classification),
			};
		} else if (classification.kind === 'bug') {
			const llmBody = await writeBugIssueBody(session, pr);
			decision = {
				action: 'create-issue',
				title: classification.suggestedTitle,
				body: bugIssueBody(pr, llmBody),
			};
		} else {
			decision = {
				action: 'create-discussion',
				title: classification.suggestedTitle,
				body: featureDiscussionBody(pr),
			};
		}

		// ─── Deterministic phase ────────────────────────────────────────────
		// No LLM beyond this point. All mutations use FREDKBOT_GITHUB_TOKEN
		// via lib/github.ts on inputs already validated above.
		//
		// Order is significant: create the destination first so the PR's
		// closing comment can link to it. If `closePullRequest` fails, a
		// maintainer can close manually — the destination still exists.
		let destinationUrl: string;
		let destinationKind: 'issue' | 'discussion' | 'duplicate';
		switch (decision.action) {
			case 'comment-on-duplicate': {
				if (decision.duplicate.kind === 'issue') {
					await commentOnIssue(decision.duplicate.number, decision.commentBody);
				} else {
					await commentOnDiscussion(decision.duplicate.number, decision.commentBody);
				}
				destinationUrl = decision.duplicate.url;
				destinationKind = 'duplicate';
				break;
			}
			case 'create-issue': {
				const created = await createIssue({ title: decision.title, body: decision.body });
				destinationUrl = created.htmlUrl;
				destinationKind = 'issue';
				break;
			}
			case 'create-discussion': {
				const created = await createDiscussion({
					title: decision.title,
					body: decision.body,
					categoryName: FEATURE_REQUEST_CATEGORY,
				});
				destinationUrl = created.url;
				destinationKind = 'discussion';
				break;
			}
		}

		await commentOnPullRequest(prNumber, closePrComment(destinationUrl, destinationKind));
		await closePullRequest(prNumber);

		// Done last so that a partial-failure run leaves the label in place
		// and a maintainer can re-trigger by removing-and-re-adding it.
		await removeLabelIfPresent(prNumber, TRIAGE_LABEL);

		log.info('pr-redirect: done', { prNumber, action: decision.action, destinationUrl });
		return { action: decision.action, destinationUrl, prNumber };
	},
});
