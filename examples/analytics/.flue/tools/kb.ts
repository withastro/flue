import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

export const DEFAULT_DOCS_ROOT = 'resources/docs';
export const DEFAULT_KB_INDEX_PATH = 'knowledge_base/INDEX.md';

type KbArticle = {
	path: string;
	title: string;
	description: string;
	aliases: string[];
};

export function createKbTools(input: { docsRoot?: string } = {}): ToolDef[] {
	const docsRoot = resolveRuntimePath(input.docsRoot || process.env.WAITER_DOCS_ROOT || DEFAULT_DOCS_ROOT);

	const readIndex: ToolDef = {
		name: 'read_kb_index',
		description:
			'Read the knowledge-base index. Use this before any KB article read; article paths must come from this index.',
		parameters: Type.Object({}),
		execute: async () => {
			const raw = await readRelativeFile(docsRoot, DEFAULT_KB_INDEX_PATH);
			const articles = parseKbIndex(raw);
			return json({
				path: DEFAULT_KB_INDEX_PATH,
				path_contract:
					'Use article.path exactly with read_kb_article. Do not invent kb/... paths; aliases are accepted only as a fallback.',
				valid_paths: articles.map((article) => article.path),
				articles,
				content: raw,
			});
		},
	};

	const readArticle: ToolDef = {
		name: 'read_kb_article',
		description:
			'Read a bounded KB article selected from read_kb_index. Use article.path exactly from the index, e.g. knowledge_base/workstation.md.',
		parameters: Type.Object({
			path: Type.String({
				description:
					'Canonical article.path returned by read_kb_index. Preferred form: knowledge_base/<article>.md. Do not use kb/<article>.md.',
			}),
			pattern: Type.Optional(Type.String({ description: 'Optional case-insensitive substring filter.' })),
			limit: Type.Optional(Type.Number({ description: 'Maximum matching lines or full-document lines. Defaults to 120.' })),
		}),
		execute: async (args) => {
			const requestedPath = asRelativePath(args.path);
			const resolved = await resolveKbArticlePath(docsRoot, requestedPath);
			const relPath = resolved.article.path;
			const limit = boundedInteger(args.limit, 'limit', 1, 300, 120);
			const raw = await readRelativeFile(docsRoot, relPath);
			const lines = raw.split('\n');
			const pattern = typeof args.pattern === 'string' && args.pattern.trim()
				? args.pattern.trim().toLowerCase()
				: undefined;
			const selected = pattern
				? lines
						.map((line, index) => ({ line, index: index + 1 }))
						.filter(({ line }) => line.toLowerCase().includes(pattern))
						.slice(0, limit)
						.map(({ line, index }) => `${index}: ${line}`)
				: lines.slice(0, limit);

			return json({
				path: relPath,
				requested_path: requestedPath,
				resolved_via_index: true,
				used_alias: resolved.usedAlias,
				valid_path: relPath,
				pattern,
				returned_lines: selected.length,
				truncated: pattern ? selected.length === limit : lines.length > limit,
				content: selected.join('\n'),
			});
		},
	};

	return [readIndex, readArticle];
}

export async function selectKbArticles(
	query: string,
	input: { docsRoot?: string; limit?: number } = {},
): Promise<Array<{ path: string; title: string; description: string }>> {
	const docsRoot = resolveRuntimePath(input.docsRoot || process.env.WAITER_DOCS_ROOT || DEFAULT_DOCS_ROOT);
	const raw = await readRelativeFile(docsRoot, DEFAULT_KB_INDEX_PATH);
	const articles = parseKbIndex(raw);
	const queryTerms = terms(query);
	const scored = articles
		.map((article) => ({
			article,
			score: [...terms(`${article.title} ${article.description} ${article.path}`)].filter((term) =>
				queryTerms.has(term),
			).length,
		}))
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.article.path.localeCompare(b.article.path))
		.map(({ article }) => ({
			path: article.path,
			title: article.title,
			description: article.description,
		}));
	return scored.slice(0, input.limit ?? 3);
}

function parseKbIndex(raw: string): KbArticle[] {
	const articles: KbArticle[] = [];
	const itemPattern = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+—\s+(.+)$/gm;
	let match: RegExpExecArray | null;
	while ((match = itemPattern.exec(raw))) {
		const title = match[1]!;
		const linkedPath = match[2]!;
		const canonicalPath = `knowledge_base/${linkedPath}`;
		const basename = path.posix.basename(linkedPath);
		articles.push({
			title,
			path: canonicalPath,
			description: match[3]!,
			aliases: [...new Set([linkedPath, basename, `kb/${basename}`, title])],
		});
	}
	return articles;
}

async function resolveKbArticlePath(
	docsRoot: string,
	requestedPath: string,
): Promise<{ article: KbArticle; usedAlias: boolean }> {
	const raw = await readRelativeFile(docsRoot, DEFAULT_KB_INDEX_PATH);
	const articles = parseKbIndex(raw);
	const normalized = normalizeArticleHandle(requestedPath);
	for (const article of articles) {
		const handles = [article.path, ...article.aliases].map(normalizeArticleHandle);
		if (handles.includes(normalized)) {
			return {
				article,
				usedAlias: normalizeArticleHandle(article.path) !== normalized,
			};
		}
	}
	const valid = articles.map((article) => article.path).join(', ');
	throw new Error(
		`Unknown KB article path "${requestedPath}". Call read_kb_index first and use one of article.path exactly. Valid paths: ${valid}`,
	);
}

function normalizeArticleHandle(value: string): string {
	return value.trim().replace(/^\/+/, '').replace(/\\/g, '/').toLowerCase();
}

async function readRelativeFile(root: string, relPath: string): Promise<string> {
	const cleanPath = asRelativePath(relPath);
	const resolved = path.resolve(root, cleanPath);
	if (!resolved.startsWith(`${root}${path.sep}`)) {
		throw new Error('Path must stay under the docs root.');
	}
	return fs.readFile(resolved, 'utf8');
}

function asRelativePath(value: unknown): string {
	if (typeof value !== 'string' || value.trim() === '') {
		throw new Error('path must be a non-empty string.');
	}
	if (path.isAbsolute(value) || value.includes('..')) {
		throw new Error('path must be relative and cannot include "..".');
	}
	return value;
}

function boundedInteger(value: unknown, name: string, min: number, max: number, defaultValue: number): number {
	if (value === undefined || value === null) return defaultValue;
	if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
		throw new Error(`${name} must be an integer between ${min} and ${max}.`);
	}
	return value;
}

function terms(text: string): Set<string> {
	return new Set(
		text
			.toLowerCase()
			.split(/[^a-z0-9_]+/)
			.filter((term) => term.length >= 3),
	);
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2);
}

function resolveRuntimePath(value: string): string {
	return path.isAbsolute(value) ? value : path.resolve(process.cwd(), value);
}
