import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

export const DEFAULT_WORKFLOW_TEMPLATES_ROOT = 'resources/workflow_templates';

type WorkflowTemplateIndexEntry = {
	id: string;
	trigger?: string;
	description?: string;
	files: string[];
};

export function createWorkflowTemplateTools(input: { root?: string } = {}): ToolDef[] {
	const root = resolveRuntimePath(input.root || process.env.WORKFLOW_TEMPLATES_ROOT || DEFAULT_WORKFLOW_TEMPLATES_ROOT);

	const listTool: ToolDef = {
		name: 'workflow_template_list',
		description:
			'List repo-defined workflow templates available to stations. User-authored personal skills are templates only; they do not define new agents or tools.',
		parameters: Type.Object({}),
		execute: async () => json({
			root,
			path_contract:
				'Call workflow_template_read with templateId from templates[].id and a file path from templates[].files.',
			templates: await listWorkflowTemplates(root),
		}),
	};

	const readTool: ToolDef = {
		name: 'workflow_template_read',
		description:
			'Read a bounded repo-defined workflow template file. Start with SKILL.md, then progressively read referenced files.',
		parameters: Type.Object({
			templateId: Type.String({ description: 'Template id returned by workflow_template_list.' }),
			path: Type.Optional(Type.String({ description: 'File path inside the template. Defaults to SKILL.md.' })),
			maxBytes: Type.Optional(Type.Number({ description: 'Maximum bytes to return. Defaults to 20000.' })),
		}),
		execute: async (args) => {
			const templateId = safePathPart(args.templateId, 'templateId');
			const relPath = args.path === undefined ? 'SKILL.md' : asRelativePath(args.path, 'path');
			const maxBytes = boundedInteger(args.maxBytes, 'maxBytes', 100, 100_000, 20_000);
			const templateRoot = path.resolve(root, templateId);
			const filePath = path.resolve(templateRoot, relPath);
			if (!filePath.startsWith(`${templateRoot}${path.sep}`)) {
				throw new Error('Template path must stay under the selected template root.');
			}
			const raw = await fs.readFile(filePath, 'utf8');
			const bytes = Buffer.byteLength(raw, 'utf8');
			return json({
				templateId,
				path: relPath,
				bytes,
				truncated: bytes > maxBytes,
				content: raw.slice(0, maxBytes),
			});
		},
	};

	return [listTool, readTool];
}

async function listWorkflowTemplates(root: string): Promise<WorkflowTemplateIndexEntry[]> {
	const entries = await fs.readdir(root, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
		if (error.code === 'ENOENT') return [];
		throw error;
	});
	const templates: WorkflowTemplateIndexEntry[] = [];
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const id = entry.name;
		const templateRoot = path.join(root, id);
		const files = await listMarkdownFiles(templateRoot);
		const main = files.includes('SKILL.md') ? await fs.readFile(path.join(templateRoot, 'SKILL.md'), 'utf8') : '';
		templates.push({
			id,
			trigger: frontmatterValue(main, 'trigger'),
			description: frontmatterBlock(main, 'description') || frontmatterValue(main, 'description'),
			files,
		});
	}
	return templates.sort((a, b) => a.id.localeCompare(b.id));
}

async function listMarkdownFiles(root: string, prefix = ''): Promise<string[]> {
	const entries = await fs.readdir(path.join(root, prefix), { withFileTypes: true });
	const files: string[] = [];
	for (const entry of entries) {
		const relPath = path.posix.join(prefix, entry.name);
		if (entry.isDirectory()) {
			files.push(...await listMarkdownFiles(root, relPath));
		} else if (entry.isFile() && /\.md$/i.test(entry.name)) {
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
