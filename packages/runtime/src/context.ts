/**
 * Context discovery: reads AGENTS.md and .agents/skills/ from a session's
 * working directory. Used at runtime by the session initialisation path.
 */
import { parseSkillMarkdown } from './skill-frontmatter.ts';
import type { SessionEnv, Skill, SkillMode } from './types.ts';

export interface WorkspaceSkill {
	readonly __flueWorkspaceSkill: true;
	readonly name: string;
	readonly description: string;
	readonly directory: string;
	readonly skillMdPath: string;
}

export function isWorkspaceSkill(skill: Skill): skill is Skill & WorkspaceSkill {
	const candidate = skill as Partial<WorkspaceSkill>;
	return (
		candidate.__flueWorkspaceSkill === true &&
		typeof candidate.directory === 'string' &&
		typeof candidate.skillMdPath === 'string'
	);
}

// ─── Context Discovery ──────────────────────────────────────────────────────

/** Read AGENTS.md (and CLAUDE.md if present) from a directory. Returns concatenated contents. */
async function readAgentsMd(env: SessionEnv, basePath: string): Promise<string> {
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

/** Path to the skills directory under a given base path. */
export function skillsDirIn(basePath: string): string {
	return basePath.endsWith('/') ? `${basePath}.agents/skills` : `${basePath}/.agents/skills`;
}

/**
 * Discover skills from `.agents/skills/<name>/SKILL.md` under basePath.
 *
 * Skill bodies are intentionally not retained. Autonomous activation
 * rereads SKILL.md before injecting its instructions, while direct name
 * invocation lets the model read workspace files itself. This keeps
 * relative references resolvable and picks up mid-session edits without
 * re-initialising the agent. We parse the frontmatter here only to
 * populate the system-prompt's "Available Skills" registry.
 *
 * Discovered skills the user didn't opt into must not be able to brick
 * the session: a malformed SKILL.md is skipped with a warning instead of
 * failing init(). Explicitly imported/packaged skills stay strict — they
 * are validated at build time where a hard error is actionable.
 */
async function discoverLocalSkills(
	env: SessionEnv,
	basePath: string,
): Promise<Record<string, Skill>> {
	const skillsDir = skillsDirIn(basePath);

	if (!(await env.exists(skillsDir))) return {};

	const skills: Record<string, Skill> = Object.create(null);
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
		let parsed: ReturnType<typeof parseSkillMarkdown>;
		try {
			parsed = parseSkillMarkdown(content, { directoryName: entry, path: skillMdPath });
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(`[flue] Skipping invalid workspace skill "${entry}": ${detail}`);
			continue;
		}
		const workspaceSkill: WorkspaceSkill = {
			__flueWorkspaceSkill: true,
			name: parsed.name,
			description: parsed.description,
			directory: skillDir,
			skillMdPath,
		};
		skills[parsed.name] = workspaceSkill;
	}

	return skills;
}

function mergeSkillCatalog(
	definitionSkills: readonly Skill[],
	discoveredSkills: Record<string, Skill>,
): Record<string, Skill> {
	const merged: Record<string, Skill> = Object.create(null);
	for (const skill of definitionSkills) {
		merged[skill.name] = skill;
	}
	for (const [name, skill] of Object.entries(discoveredSkills)) {
		if (Object.hasOwn(merged, name)) {
			throw new Error(
				`[flue] Skill name "${name}" appears in both agent definition and workspace discovery.`,
			);
		}
		merged[name] = skill;
	}
	return merged;
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
const HEADLESS_PREAMBLE =
	'You are running in headless mode with no human operator. Work autonomously — never ask questions, never wait for user input. Make your best judgment and proceed independently.';

function composeSystemPrompt(
	agentsMd: string,
	skills: Record<string, Skill>,
	env?: { cwd: string; directoryListing?: string[] },
	instructions?: string,
	skillMode: SkillMode = 'activate',
): string {
	const parts: string[] = [HEADLESS_PREAMBLE];

	if (instructions) parts.push('', instructions);
	if (agentsMd) parts.push('', agentsMd);

	const skillEntries = Object.values(skills);
	if (skillEntries.length > 0) {
		parts.push('', '## Available Skills', '');
		parts.push(
			skillMode === 'files'
				? 'The following skills are ordinary files. When a task matches a skill description, read its `SKILL.md` file with the normal `read` tool before proceeding. Resolve supporting paths relative to that skill directory.'
				: 'The following skills provide specialized instructions for specific tasks. When a task matches a skill description, call the `activate_skill` tool with that skill name before proceeding so its full instructions are loaded. Skill instructions and supporting resources stay lazy until activation or explicit file reads.',
			'',
		);
		for (const skill of skillEntries) {
			const desc = skill.description ? ` — ${skill.description}` : '';
			const path = skillMode === 'files' ? skillMdPath(skill) : undefined;
			if (skillMode === 'files' && !path) {
				throw new Error(
					`[flue] Skill "${skill.name}" cannot use files mode because it has no readable SKILL.md file.`,
				);
			}
			parts.push(`- **${skill.name}**${desc}${path ? ` — ${path}` : ''}`);
		}
	}

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

/** Discover AGENTS.md, local skills, and directory listing from the session's cwd. */
export async function discoverSessionContext(
	env: SessionEnv,
	instructions?: string,
	definitionSkills: readonly Skill[] = [],
	skillMode: SkillMode = 'activate',
): Promise<{ systemPrompt: string; skills: Record<string, Skill> }> {
	const cwd = env.cwd;

	const agentsMd = await readAgentsMd(env, cwd);
	const skills = mergeSkillCatalog(definitionSkills, await discoverLocalSkills(env, cwd));

	let directoryListing: string[] | undefined;
	try {
		directoryListing = await env.readdir(cwd);
	} catch {
		// readdir failed (e.g., cwd doesn't exist yet) — skip silently
	}

	const systemPrompt = composeSystemPrompt(
		agentsMd,
		skills,
		{
			cwd,
			directoryListing,
		},
		instructions,
		skillMode,
	);

	return { systemPrompt, skills };
}

function skillMdPath(skill: Skill): string | undefined {
	if (isWorkspaceSkill(skill)) return skill.skillMdPath;
	if ('__flueSkillReference' in skill && skill.__flueSkillReference === true) {
		return `/.flue/packaged-skills/${encodeURIComponent(skill.id)}/SKILL.md`;
	}
	return undefined;
}
