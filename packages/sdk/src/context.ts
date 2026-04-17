/**
 * Context discovery: reads AGENTS.md and .agents/skills/ from a session's
 * working directory. Used at runtime by the session initialisation path.
 */
import type { SessionEnv, Skill } from './types.ts';

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

/** Read AGENTS.md (and CLAUDE.md if present) from a directory. Returns concatenated contents. */
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

/** Discover skills from .agents/skills/<name>/SKILL.md under basePath. */
export async function discoverLocalSkills(
	env: SessionEnv,
	basePath: string,
): Promise<Record<string, Skill>> {
	const skillsDir = basePath.endsWith('/')
		? `${basePath}.agents/skills`
		: `${basePath}/.agents/skills`;

	if (!(await env.exists(skillsDir))) return {};

	const skills: Record<string, Skill> = {};
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
			instructions: parsed.body,
		};
	}

	return skills;
}

export function composeSystemPrompt(
	agentsMd: string,
	skills: Record<string, Skill>,
	env?: { cwd: string; directoryListing?: string[] },
): string {
	const parts: string[] = [];

	if (agentsMd) parts.push(agentsMd);

	const skillEntries = Object.values(skills);
	if (skillEntries.length > 0) {
		parts.push('', '## Available Skills', '');
		for (const skill of skillEntries) {
			const desc = skill.description ? ` - ${skill.description}` : '';
			parts.push(`- **${skill.name}**${desc}`);
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
): Promise<{ systemPrompt: string; skills: Record<string, Skill> }> {
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
