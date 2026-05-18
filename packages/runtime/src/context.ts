/**
 * Context discovery: reads AGENTS.md and .agents/skills/ from a session's
 * working directory. Used at runtime by the session initialisation path.
 */
import type { AgentDefinition, SessionEnv, SkillDefinition } from './types.ts';

// ─── Frontmatter Parsing ────────────────────────────────────────────────────

interface FrontmatterResult {
	name: string;
	description: string;
	body: string;
	frontmatter: Record<string, string>;
}

/** Parse optional YAML frontmatter (--- delimited). Basic `key: value` only. */
export function parseFrontmatterFile(content: string, defaultName: string): FrontmatterResult {
	const frontmatterMatch = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);

	if (!frontmatterMatch) {
		return { name: defaultName, description: '', body: content.trim(), frontmatter: {} };
	}

	const rawFrontmatter = frontmatterMatch[1] ?? '';
	const body = frontmatterMatch[2] ?? '';
	const frontmatter: Record<string, string> = {};

	for (const line of rawFrontmatter.split('\n')) {
		const match = line.match(/^(\w+):\s*(.+)$/);
		if (match?.[1] && match[2]) frontmatter[match[1]] = match[2].trim();
	}

	return {
		name: frontmatter.name || defaultName,
		description: frontmatter.description || '',
		body: body.trim(),
		frontmatter,
	};
}

// ─── Context Discovery ──────────────────────────────────────────────────────

/** Phase 3: used by `loadFromSandbox` when workspace context discovery returns. */
export async function readAgentsMd(env: SessionEnv, basePath: string): Promise<string> {
	const parts: string[] = [];

	for (const filename of ['AGENTS.md', 'CLAUDE.md']) {
		const filePath = basePath.endsWith('/') ? basePath + filename : `${basePath}/${filename}`;
		if (await env.exists(filePath)) {
			const content = await env.readFile(filePath);
			parts.push(content.trim());
		}
	}

	return parts.join('\n\n');
}

/** Phase 3: used by `loadFromSandbox` skill discovery. */
export function skillsDirIn(basePath: string): string {
	return basePath.endsWith('/') ? `${basePath}.agents/skills` : `${basePath}/.agents/skills`;
}

/**
 * Resolve a skill referenced by relative path under `.agents/skills/`,
 * returning the absolute filesystem path or `null` if the file doesn't
 * exist.
 *
 * The relative path is taken as-is — no extension is auto-appended.
 * Callers reference the full filename, e.g. `'triage/reproduce.md'`.
 *
 * Used by `session.skill()` when the caller passes a path-shaped name
 * (contains `/` or ends in `.md`/`.markdown`). Path-based references
 * bypass the skill registry entirely — the model is given the resolved
 * path and reads the file directly. We don't parse the file here
 * because nothing on the server side needs the frontmatter for these
 * skills; only the model does, and it reads the file itself.
 */
// Phase 3: used by sandbox-loaded path skill activation if that escape hatch remains.
export async function resolveSkillFilePath(
	env: SessionEnv,
	basePath: string,
	relPath: string,
): Promise<string | null> {
	const filePath = `${skillsDirIn(basePath)}/${relPath}`;
	if (!(await env.exists(filePath))) return null;
	return filePath;
}

/**
 * Discover skills from `.agents/skills/<name>/SKILL.md` under basePath.
 *
 * Skill bodies are intentionally not retained — at call time the model
 * reads the file from disk itself, which keeps relative references
 * inside the skill resolvable from where they live and lets users edit
 * skill files mid-session without re-initialising the agent. We parse
 * the frontmatter here only to populate the system-prompt's "Available
 * Skills" registry (name + description).
 */
// Phase 3: becomes the sandbox skill discovery body behind `loadFromSandbox`.
export async function discoverLocalSkills(
	env: SessionEnv,
	basePath: string,
): Promise<Record<string, SkillDefinition>> {
	const skillsDir = skillsDirIn(basePath);

	if (!(await env.exists(skillsDir))) return {};

	const skills: Record<string, SkillDefinition> = {};
	const entries = await env.readdir(skillsDir);

	for (const entry of entries) {
		const skillDir = `${skillsDir}/${entry}`;

		try {
			const s = await env.stat(skillDir);
			if (!s.isDirectory) continue;
		} catch {
			continue;
		}

		const skillMdPath = `${skillDir}/SKILL.md`;
		if (!(await env.exists(skillMdPath))) continue;

		const content = await env.readFile(skillMdPath);
		const parsed = parseFrontmatterFile(content, entry);
		skills[parsed.name] = {
			name: parsed.name,
			description: parsed.description,
			body: parsed.body,
			source: { kind: 'local', path: skillMdPath },
		};
	}

	return skills;
}

/**
 * Headless-mode preamble. Included once at the top of every session's
 * system prompt so the model knows it's running without a human operator
 * before the first turn — and doesn't get reminded of it on every
 * `prompt()` / `skill()` call. Previously this lived in
 * `result.ts:buildPromptText` / `buildSkillPrompt` and was inlined into
 * each per-call user message; that was redundant noise once the harness
 * gained tool-call shape (it can't ask questions or wait for input
 * regardless of what the user message says).
 */
export const HEADLESS_PREAMBLE =
	'You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input. Make your best judgment and proceed independently.';

export function composeSystemPrompt(
	agentsMd: string,
	skills: Record<string, SkillDefinition>,
	env?: { cwd: string; directoryListing?: string[] },
): string {
	const parts: string[] = [HEADLESS_PREAMBLE];

	if (agentsMd) parts.push('', agentsMd);

	appendSkillPrompt(parts, Object.values(skills));

	if (env) {
		const date = new Date().toLocaleDateString('en-US', {
			weekday: 'short',
			year: 'numeric',
			month: 'short',
			day: 'numeric',
		});
		parts.push('', `Date: ${date}`);
		parts.push(`Working directory: ${env.cwd}`);
		if (env.directoryListing && env.directoryListing.length > 0) {
			parts.push('', 'Directory structure:', env.directoryListing.join('\n'));
		}
	}

	return parts.join('\n');
}

export function composeAgentSystemPrompt(agent: AgentDefinition): string {
	const parts: string[] = [HEADLESS_PREAMBLE];
	if (agent.instructions) parts.push('', agent.instructions);
	appendSkillPrompt(parts, agent.skills ?? []);
	const subagents = agent.subagents ?? [];
	if (subagents.length > 0) {
		parts.push('', '<task_agents>');
		for (const subagent of subagents) {
			const description = subagent.description ? ` description=${JSON.stringify(subagent.description)}` : '';
			parts.push(`<agent name=${JSON.stringify(subagent.name)}${description} />`);
		}
		parts.push('</task_agents>');
	}
	return parts.join('\n');
}

function appendSkillPrompt(parts: string[], skills: readonly SkillDefinition[]): void {
	if (skills.length === 0) return;
	parts.push('', '<skills>', 'Load a skill only when its metadata matches the current task.');
	for (const skill of skills) {
		parts.push(`<skill name=${JSON.stringify(skill.name)} description=${JSON.stringify(skill.description)} />`);
	}
	parts.push('</skills>');
}

/**
 * Discover AGENTS.md, local skills, and directory listing from the session's cwd.
 * Phase 3 moves sandbox-backed AGENTS.md and skill discovery behind
 * `init({ loadFromSandbox })`; keep this call site explicit until then.
 */
export async function discoverSessionContext(
	env: SessionEnv,
): Promise<{ systemPrompt: string; skills: Record<string, SkillDefinition> }> {
	const cwd = env.cwd;

	const agentsMd = await readAgentsMd(env, cwd);
	const skills = await discoverLocalSkills(env, cwd);

	let directoryListing: string[] | undefined;
	try {
		directoryListing = await env.readdir(cwd);
	} catch {
		// readdir failed (e.g., cwd doesn't exist yet) — skip silently
	}

	const systemPrompt = composeSystemPrompt(agentsMd, skills, {
		cwd,
		directoryListing,
	});

	return { systemPrompt, skills };
}
