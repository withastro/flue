import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export const DEFAULT_DBT_SKILL_ROOT = 'resources/skills/dbt';

const defaultReferenceFiles = [
	'references/consultation.md',
	'references/development.md',
	'references/documentation.md',
	'references/manifest_search.md',
];

export async function loadDbtSkillInstructions(input: { skillRoot?: string } = {}): Promise<string> {
	const skillRoot = resolveRuntimePath(input.skillRoot || process.env.DBT_SKILL_ROOT || DEFAULT_DBT_SKILL_ROOT);
	const parts = [await readSkillFile(skillRoot, 'SKILL.md')];
	for (const relPath of defaultReferenceFiles) {
		parts.push(await readSkillFile(skillRoot, relPath));
	}
	return parts.join('\n\n---\n\n');
}

async function readSkillFile(root: string, relPath: string): Promise<string> {
	const resolved = path.resolve(root, relPath);
	if (!resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error('DBT skill path must stay under skill root.');
	}
	const raw = await fs.readFile(resolved, 'utf8');
	return `<dbt-skill-file path="${relPath}">\n${raw}\n</dbt-skill-file>`;
}

function resolveRuntimePath(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
