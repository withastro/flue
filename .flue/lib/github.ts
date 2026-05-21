/**
 * GitHub write API for the `pr-redirect` agent.
 *
 * Every function here authenticates as `astrobot-houston` via the
 * `FREDKBOT_GITHUB_TOKEN` env var, so all created issues, discussions,
 * and comments attribute to the bot. This module is deliberately
 * write-only: the agent does all reads through the `gh` CLI inside its
 * sandbox, which carries only the read-only `GITHUB_TOKEN`.
 *
 * Keeping this module unreachable from inside `session.shell` is what
 * makes the agent's prompt injection blast radius bounded. See the
 * security note in `.flue/workflows/pr-redirect.ts`.
 */

const REPO = process.env.GITHUB_REPOSITORY ?? 'withastro/flue';

function requireBotToken(): string {
	const token = process.env.FREDKBOT_GITHUB_TOKEN;
	if (!token) {
		throw new Error(
			'FREDKBOT_GITHUB_TOKEN env var is required for deterministic GitHub mutations.',
		);
	}
	return token;
}

function headers(): Record<string, string> {
	return {
		Authorization: `token ${requireBotToken()}`,
		'Content-Type': 'application/json',
		Accept: 'application/vnd.github+json',
		'User-Agent': 'flue-pr-redirect',
	};
}

async function rest(
	method: string,
	path: string,
	body?: Record<string, unknown>,
): Promise<unknown> {
	const res = await fetch(`https://api.github.com${path}`, {
		method,
		headers: headers(),
		body: body ? JSON.stringify(body) : undefined,
	});
	if (!res.ok) {
		const text = await res.text();
		throw new Error(`GitHub REST ${method} ${path} failed (HTTP ${res.status}): ${text}`);
	}
	// Tolerate both empty (204) and JSON bodies.
	const text = await res.text();
	return text ? JSON.parse(text) : null;
}

interface GraphQLResponse<T> {
	data?: T;
	errors?: Array<{ message: string }>;
}

async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
	const res = await fetch('https://api.github.com/graphql', {
		method: 'POST',
		headers: headers(),
		body: JSON.stringify({ query, variables }),
	});
	if (!res.ok) {
		throw new Error(`GitHub GraphQL failed (HTTP ${res.status}): ${await res.text()}`);
	}
	const body = (await res.json()) as GraphQLResponse<T>;
	if (body.errors?.length) {
		throw new Error(`GitHub GraphQL errors: ${body.errors.map((e) => e.message).join('; ')}`);
	}
	if (!body.data) throw new Error('GitHub GraphQL returned no data');
	return body.data;
}

// ─── REST writes ────────────────────────────────────────────────────────────

export interface CreateIssueResult {
	number: number;
	htmlUrl: string;
}

export async function createIssue(input: {
	title: string;
	body: string;
}): Promise<CreateIssueResult> {
	const res = (await rest('POST', `/repos/${REPO}/issues`, {
		title: input.title,
		body: input.body,
	})) as { number: number; html_url: string };
	return { number: res.number, htmlUrl: res.html_url };
}

export async function commentOnIssue(issueNumber: number, body: string): Promise<void> {
	await rest('POST', `/repos/${REPO}/issues/${issueNumber}/comments`, { body });
}

/** GitHub treats PRs as issues for the comments endpoint. */
export async function commentOnPullRequest(prNumber: number, body: string): Promise<void> {
	await commentOnIssue(prNumber, body);
}

export async function closePullRequest(prNumber: number): Promise<void> {
	await rest('PATCH', `/repos/${REPO}/pulls/${prNumber}`, { state: 'closed' });
}

/**
 * Remove a label from an issue or PR. No-op if the label isn't applied
 * (GitHub returns 404, which we swallow). Other errors throw.
 */
export async function removeLabelIfPresent(issueOrPrNumber: number, label: string): Promise<void> {
	const res = await fetch(
		`https://api.github.com/repos/${REPO}/issues/${issueOrPrNumber}/labels/${encodeURIComponent(label)}`,
		{ method: 'DELETE', headers: headers() },
	);
	if (!res.ok && res.status !== 404) {
		throw new Error(`GitHub REST DELETE label failed (HTTP ${res.status}): ${await res.text()}`);
	}
}

// ─── GraphQL: discussions ───────────────────────────────────────────────────

/**
 * Discussions are GraphQL-only on GitHub's API. Creating one requires
 * the repository node ID and the target category's node ID; both are
 * stable per-repo, so we fetch them once per process.
 */
let cachedDiscussionMeta: { repositoryId: string; categories: Map<string, string> } | null = null;

async function getDiscussionMeta(): Promise<{
	repositoryId: string;
	categories: Map<string, string>;
}> {
	if (cachedDiscussionMeta) return cachedDiscussionMeta;
	const [owner, name] = REPO.split('/');
	if (!owner || !name) throw new Error(`Invalid GITHUB_REPOSITORY: ${REPO}`);
	const data = await graphql<{
		repository: {
			id: string;
			discussionCategories: { nodes: Array<{ id: string; name: string; slug: string }> };
		};
	}>(
		`
			query ($owner: String!, $name: String!) {
				repository(owner: $owner, name: $name) {
					id
					discussionCategories(first: 50) {
						nodes {
							id
							name
							slug
						}
					}
				}
			}
		`,
		{ owner, name },
	);
	const categories = new Map<string, string>();
	for (const cat of data.repository.discussionCategories.nodes) {
		categories.set(cat.name.toLowerCase(), cat.id);
		categories.set(cat.slug.toLowerCase(), cat.id);
	}
	cachedDiscussionMeta = { repositoryId: data.repository.id, categories };
	return cachedDiscussionMeta;
}

export interface CreateDiscussionResult {
	number: number;
	url: string;
	id: string;
}

export async function createDiscussion(input: {
	title: string;
	body: string;
	/** Case-insensitive match against category name or slug. */
	categoryName: string;
}): Promise<CreateDiscussionResult> {
	const meta = await getDiscussionMeta();
	const categoryId = meta.categories.get(input.categoryName.toLowerCase());
	if (!categoryId) {
		const available = [...new Set(meta.categories.keys())].join(', ');
		throw new Error(
			`Discussion category "${input.categoryName}" not found. Available: ${available}`,
		);
	}
	const data = await graphql<{
		createDiscussion: { discussion: { number: number; url: string; id: string } };
	}>(
		`
			mutation ($repositoryId: ID!, $categoryId: ID!, $title: String!, $body: String!) {
				createDiscussion(
					input: {
						repositoryId: $repositoryId
						categoryId: $categoryId
						title: $title
						body: $body
					}
				) {
					discussion {
						number
						url
						id
					}
				}
			}
		`,
		{
			repositoryId: meta.repositoryId,
			categoryId,
			title: input.title,
			body: input.body,
		},
	);
	return data.createDiscussion.discussion;
}

/**
 * Comment on a discussion by its number. GitHub's GraphQL mutation
 * takes a node ID, so we look that up first.
 */
export async function commentOnDiscussion(discussionNumber: number, body: string): Promise<void> {
	const [owner, name] = REPO.split('/');
	if (!owner || !name) throw new Error(`Invalid GITHUB_REPOSITORY: ${REPO}`);
	const lookup = await graphql<{ repository: { discussion: { id: string } | null } }>(
		`
			query ($owner: String!, $name: String!, $number: Int!) {
				repository(owner: $owner, name: $name) {
					discussion(number: $number) {
						id
					}
				}
			}
		`,
		{ owner, name, number: discussionNumber },
	);
	const discussionId = lookup.repository.discussion?.id;
	if (!discussionId) {
		throw new Error(`Discussion #${discussionNumber} not found in ${REPO}`);
	}
	await graphql(
		`
			mutation ($discussionId: ID!, $body: String!) {
				addDiscussionComment(input: { discussionId: $discussionId, body: $body }) {
					comment {
						id
					}
				}
			}
		`,
		{ discussionId, body },
	);
}
