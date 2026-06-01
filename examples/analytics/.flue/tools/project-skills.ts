import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

export const DEFAULT_PROJECT_SKILLS_ROOT = 'resources/skills';

type ProjectSkillIndexEntry = {
	id: string;
	name?: string;
	trigger: string;
	description?: string;
	alwaysLoaded: boolean;
	files: string[];
};

const ALWAYS_LOADED_SKILLS = new Set(['dbt']);

export function createProjectSkillTools(input: { root?: string } = {}): ToolDef[] {
	const root = resolveRuntimePath(input.root || process.env.PROJECT_SKILLS_ROOT || DEFAULT_PROJECT_SKILLS_ROOT);

	const listTool: ToolDef = {
		name: 'project_skill_list',
		description:
			'List repo-defined project skills bundled with the AGI agent. Use this before reading a skill; load only skills relevant to the current task.',
		parameters: Type.Object({}),
		execute: async () => json({
			root,
			path_contract:
				'Call project_skill_read with skillId from skills[].id and a file path from skills[].files.',
			skills: await listProjectSkills(root),
		}),
	};

	const readTool: ToolDef = {
		name: 'project_skill_read',
		description:
			'Read a bounded repo-defined project skill file. Start with SKILL.md, then progressively read referenced files.',
		parameters: Type.Object({
			skillId: Type.String({ description: 'Skill id returned by project_skill_list.' }),
			path: Type.Optional(Type.String({ description: 'File path inside the skill. Defaults to SKILL.md.' })),
			maxBytes: Type.Optional(Type.Number({ description: 'Maximum bytes to return. Defaults to 20000.' })),
		}),
		execute: async (args) => {
			const skillId = safePathPart(args.skillId, 'skillId');
			const relPath = args.path === undefined ? 'SKILL.md' : asRelativePath(args.path, 'path');
			const maxBytes = boundedInteger(args.maxBytes, 'maxBytes', 100, 100_000, 20_000);
			const skillRoot = path.resolve(root, skillId);
			const filePath = path.resolve(skillRoot, relPath);
			if (!filePath.startsWith(`${skillRoot}${path.sep}`)) {
				throw new Error('Skill path must stay under the selected skill root.');
			}
			const raw = await fs.readFile(filePath, 'utf8');
			const bytes = Buffer.byteLength(raw, 'utf8');
			return json({
				skillId,
				path: relPath,
				bytes,
				truncated: bytes > maxBytes,
				content: raw.slice(0, maxBytes),
			});
		},
	};

	return [listTool, readTool];
}

async function listProjectSkills(root: string): Promise<ProjectSkillIndexEntry[]> {
	const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});
	const skills: ProjectSkillIndexEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const id = entry.name;
		const skillRoot = path.join(root, id);
		const files = await listFiles(skillRoot);
		const main = files.includes('SKILL.md') ? await fs.readFile(path.join(skillRoot, 'SKILL.md'), 'utf8') : '';
		skills.push({
			id,
			name: id,
			trigger: id,
			description: frontmatterBlock(main, 'description') || frontmatterValue(main, 'description'),
			alwaysLoaded: ALWAYS_LOADED_SKILLS.has(id),
			files,
		});
	}
	return skills.sort((a, b) => a.id.localeCompare(b.id));
}

async function listFiles(root: string, prefix = ''): Promise<string[]> {
	const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relPath = path.posix.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listFiles(root, relPath));
		} else if (entry.isFile()) {
			files.push(relPath);
		}
	}
	return files.sort();
}

function frontmatterValue(raw: string, key: string): string | undefined {
	const match = raw.match(new RegExp(`^${key}:\\s*["']?([^"'\\n]+)["']?\\s*$`, 'm'));
	return match?.[1]?.trim();
}

function frontmatterBlock(raw: string, key: string): string | undefined {
	const match = raw.match(new RegExp(`^${key}:\\s*\\|\\n((?:  .+\\n?)+)`, 'm'));
	return match?.[1]
		?.split('\n')
		.map((line) => line.replace(/^  /, ''))
		.join('\n')
		.trim();
}

function asRelativePath(value: unknown, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') throw new Error(`${name} must be a non-empty string.`);
	const cleaned = value.trim().replace(/\\/g, '/').replace(/^\/+/, '');
	if (path.isAbsolute(cleaned) || cleaned.includes('..')) throw new Error(`${name} must be relative and cannot include "..".`);
	return cleaned;
}

function safePathPart(value: unknown, name: string): string {
	const part = asRelativePath(value, name);
	if (part.includes('/')) throw new Error(`${name} must be a single path segment.`);
	return part;
}

function boundedInteger(value: unknown, name: string, min: number, max: number, defaultValue: number): number {
	if (value === undefined || value === null) return defaultValue;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}.`);
	}
	return value;
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function resolveRuntimePath(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
