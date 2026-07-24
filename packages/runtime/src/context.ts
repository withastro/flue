/**
 * Context discovery: reads AGENTS.md and .agents/skills/ from a session's
 * working directory. Used at runtime by the session initialisation path.
 */
import { parseSkillMarkdown } from './skill-frontmatter.ts';
import type { RegisteredSkill, SessionEnv, Skill, WorkspaceSkill } from './types.ts';

export function isWorkspaceSkill(skill: RegisteredSkill): skill is WorkspaceSkill {
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
): Promise<Record<string, WorkspaceSkill>> {
	const skillsDir = skillsDirIn(basePath);

	if (!(await env.exists(skillsDir))) return {};

	const skills: Record<string, WorkspaceSkill> = Object.create(null);
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

		let parsed: ReturnType<typeof parseSkillMarkdown>;
		try {
			const content = await env.readFile(skillMdPath);
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
	discoveredSkills: Record<string, WorkspaceSkill>,
): Record<string, RegisteredSkill> {
	const merged: Record<string, RegisteredSkill> = Object.create(null);
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

/** One line of the system prompt's skill or agent catalog. */
export interface SkillCatalogEntry {
	name: string;
	description?: string;
}

/**
 * The composed system prompt is load-bearing machinery only: the agent's
 * instructions, discovered workspace context, the skill catalog, the task
 * roster, and environment facts. Flue adds no behavioral stance of its own
 * (an autonomy preamble used to live here) — how an agent should behave is
 * the agent function's instructions to give.
 */
function composeSystemPrompt(
	agentsMd: string,
	catalog: readonly SkillCatalogEntry[],
	agentCatalog: readonly SkillCatalogEntry[],
	env?: { cwd: string; directoryListing?: string[] },
	instructions?: string,
): string {
	const parts: string[] = [];
	const pushSection = (...lines: string[]) => {
		if (parts.length > 0) parts.push('');
		parts.push(...lines);
	};

	if (instructions) pushSection(instructions);
	if (agentsMd) pushSection(agentsMd);

	if (catalog.length > 0) {
		pushSection(
			'## Available Skills',
			'',
			'The following skills provide specialized instructions for specific tasks. When a task matches a skill description, call the `activate_skill` tool with that skill name before proceeding so its full instructions are loaded. Skill instructions and supporting resources stay lazy until activation or explicit file reads.',
			'',
		);
		for (const skill of catalog) {
			const desc = skill.description ? ` — ${skill.description}` : '';
			parts.push(`- **${skill.name}**${desc}`);
		}
	}

	// The `task` tool's roster lives HERE, not in the tool description: the
	// tool spec is fully static so roster changes never touch the serialized
	// tools block (which providers cache as its own prefix segment). This
	// section swaps only where the prompt already changes (compaction
	// rebaseline); mid-window roster changes are announced as `resources`
	// signals. Rendered in both states because the tool is always present —
	// an empty roster needs the "do not call it" instruction.
	if (agentCatalog.length > 0) {
		pushSection(
			'## Available Agents',
			'',
			'You can delegate focused work to one of these agents with the `task` tool, naming the agent to use. The list can change over the conversation — additions and removals are announced.',
			'',
		);
		for (const agent of agentCatalog) {
			const desc = agent.description ? ` — ${agent.description}` : '';
			parts.push(`- **${agent.name}**${desc}`);
		}
	} else {
		pushSection(
			'## Available Agents',
			'',
			'None. No subagents are currently declared, so the `task` tool has no valid `agent` value — do not call it unless an agent is introduced later in the conversation.',
		);
	}

	const date = new Date().toLocaleDateString('en-US', {
		weekday: 'short',
		year: 'numeric',
		month: 'short',
		day: 'numeric',
	});
	pushSection(`Date: ${date}`);
	if (env) {
		parts.push(`Working directory: ${env.cwd}`);
		if (env.directoryListing && env.directoryListing.length > 0) {
			parts.push('', 'Directory structure:', env.directoryListing.join('\n'));
		}
	}

	return parts.join('\n');
}

/**
 * Discover AGENTS.md, local skills, and directory listing from the session's
 * cwd. Composition is the caller's move: seed the catalogs first, then
 * `recompose(instructions)` — an initial composition here would necessarily
 * predate the catalog baseline.
 */
export async function discoverSessionContext(
	env: SessionEnv | undefined,
	definitionSkills: readonly Skill[] = [],
): Promise<{
	skills: Record<string, RegisteredSkill>;
	recompose: (instructions?: string) => string;
	setCatalog: (entries: readonly SkillCatalogEntry[]) => void;
	setAgentCatalog: (entries: readonly SkillCatalogEntry[]) => void;
	mergeSkills: (nextDefinitionSkills: readonly Skill[]) => Record<string, RegisteredSkill>;
}> {
	// No sandbox, no workspace: nothing to discover. Declared skills still
	// register, and the composed prompt simply carries no workspace facts.
	const agentsMd = env ? await readAgentsMd(env, env.cwd) : '';
	const discoveredSkills = env ? await discoverLocalSkills(env, env.cwd) : {};
	const skills = mergeSkillCatalog(definitionSkills, discoveredSkills);

	let directoryListing: string[] | undefined;
	if (env) {
		try {
			directoryListing = await env.readdir(env.cwd);
		} catch {
			// readdir failed (e.g., cwd doesn't exist yet) — skip silently
		}
	}

	// The catalog the prompt lists is a BASELINE snapshot, not the live skill
	// set: dynamically declared skills announce themselves via `resources`
	// signals instead of rewriting the prompt (which would invalidate the
	// provider's prompt cache). `setCatalog` swaps the baseline — at init
	// (durable baseline from a previous life) and at compaction rebaseline.
	let catalog: readonly SkillCatalogEntry[] = skillCatalogEntries(skills);
	const setCatalog = (entries: readonly SkillCatalogEntry[]) => {
		catalog = entries;
	};

	// The subagent roster ("Available Agents") is a baseline snapshot with the
	// same freeze semantics as the skill catalog. Subagents come from the
	// render, not workspace discovery, so it starts empty and the caller seeds
	// it (init baseline) and swaps it (compaction rebaseline).
	let agentCatalog: readonly SkillCatalogEntry[] = [];
	const setAgentCatalog = (entries: readonly SkillCatalogEntry[]) => {
		agentCatalog = entries;
	};

	// Rebuild the system prompt around new instructions without re-touching
	// the filesystem — the per-turn re-render path recomposes with whatever
	// the latest render returned, over the same discovered context.
	const recompose = (nextInstructions?: string) =>
		composeSystemPrompt(
			agentsMd,
			catalog,
			agentCatalog,
			env ? { cwd: env.cwd, directoryListing } : undefined,
			nextInstructions,
		);

	// The LIVE skill map for a later render's declared skills, merged over
	// the same discovered workspace skills. Activation resolves against this,
	// independent of the frozen catalog above.
	const mergeSkills = (nextDefinitionSkills: readonly Skill[]) =>
		mergeSkillCatalog(nextDefinitionSkills, discoveredSkills);

	return {
		skills,
		recompose,
		setCatalog,
		setAgentCatalog,
		mergeSkills,
	};
}

/** The model-facing catalog lines of a skill map (name + description only). */
export function skillCatalogEntries(skills: Record<string, RegisteredSkill>): SkillCatalogEntry[] {
	return Object.values(skills).map((skill) => ({
		name: skill.name,
		...(skill.description ? { description: skill.description } : {}),
	}));
}
