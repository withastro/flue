import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { Type, type ToolDef } from '@flue/runtime';

export const DEFAULT_WAITER_DOCS_ROOT =
	'/Users/billgu/Workspace/evenup-internal-tools/apps/dbt-explorer-api/claude-copy/docs';
export const DEFAULT_SOURCE_CATALOG_PATH =
	'/Users/billgu/Workspace/flue/examples/analytics/source_catalog.md';
export const DEFAULT_KB_INDEX_PATH = 'knowledge_base/INDEX.md';

export function createWaiterDocsTools(input: { docsRoot?: string } = {}): ToolDef[] {
	const docsRoot = path.resolve(input.docsRoot || process.env.WAITER_DOCS_ROOT || DEFAULT_WAITER_DOCS_ROOT);
	const sourceCatalogPath = path.resolve(process.env.SOURCE_CATALOG_PATH || DEFAULT_SOURCE_CATALOG_PATH);

	const readSourceCatalog: ToolDef = {
		name: 'read_source_catalog',
		description: 'Read the source catalog that explains which sources should be searched for which user intents.',
		parameters: Type.Object({}),
		execute: async () => readSourceCatalogText({ sourceCatalogPath }),
	};

	const readIndex: ToolDef = {
		name: 'read_kb_index',
		description:
			'Read the knowledge-base index. Use this first to choose the specific KB article to inspect.',
		parameters: Type.Object({}),
		execute: async () => {
			const raw = await readRelativeFile(docsRoot, DEFAULT_KB_INDEX_PATH);
			return json({
				path: DEFAULT_KB_INDEX_PATH,
				articles: parseKbIndex(raw),
				content: raw,
			});
		},
	};

	const readArticle: ToolDef = {
		name: 'read_kb_article',
		description:
			'Read a bounded KB article selected from read_kb_index. Use exact relative article paths from the index.',
		parameters: Type.Object({
			path: Type.String({ description: 'Relative markdown path returned by read_kb_index.' }),
			pattern: Type.Optional(Type.String({ description: 'Optional case-insensitive substring filter.' })),
			limit: Type.Optional(Type.Number({ description: 'Maximum matching lines or full-document lines. Defaults to 120.' })),
		}),
		execute: async (args) => {
			const relPath = asRelativePath(args.path);
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
				pattern,
				returned_lines: selected.length,
				truncated: pattern ? selected.length === limit : lines.length > limit,
				content: selected.join('\n'),
			});
		},
	};

	return [readSourceCatalog, readIndex, readArticle];
}

export async function readSourceCatalogText(input: { sourceCatalogPath?: string } = {}): Promise<string> {
	const sourceCatalogPath = path.resolve(
		input.sourceCatalogPath || process.env.SOURCE_CATALOG_PATH || DEFAULT_SOURCE_CATALOG_PATH,
	);
	return fs.readFile(sourceCatalogPath, 'utf8');
}

export async function selectKbArticles(
	query: string,
	input: { docsRoot?: string; limit?: number } = {},
): Promise<Array<{ path: string; title: string; description: string }>> {
	const docsRoot = path.resolve(input.docsRoot || process.env.WAITER_DOCS_ROOT || DEFAULT_WAITER_DOCS_ROOT);
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
		.map(({ article }) => article);
	return scored.slice(0, input.limit ?? 3);
}

function parseKbIndex(raw: string): Array<{ path: string; title: string; description: string }> {
	const articles = [];
	const itemPattern = /^-\s+\[([^\]]+)\]\(([^)]+)\)\s+—\s+(.+)$/gm;
	let match: RegExpExecArray | null;
	while ((match = itemPattern.exec(raw))) {
		articles.push({
			title: match[1]!,
			path: `knowledge_base/${match[2]!}`,
			description: match[3]!,
		});
	}
	return articles;
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
