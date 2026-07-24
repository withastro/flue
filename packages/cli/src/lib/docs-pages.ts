import * as fs from 'node:fs';
import path from 'node:path';
import { cliPackageRoot } from './package-root.ts';

/** Pure helpers behind `flue docs`: locate, load, and index the docs tree. */

export interface DocsPage {
	/** Page path without extension, e.g. `guide/sandboxes`. */
	path: string;
	title: string;
	description: string;
	/** Markdown body without frontmatter. */
	body: string;
}

/**
 * Locate the documentation markdown tree.
 *
 * For users of the published package this is always `<package root>/docs`,
 * placed there by `scripts/prepare-publish.mjs` at release time.
 *
 * The `apps/docs` candidate exists only for development inside the Flue
 * monorepo itself and can never resolve in a user's `node_modules`. It is
 * checked first because in a repo checkout the docs site content is the
 * source of truth, and a stale `<package root>/docs` snapshot left behind by
 * a local release (gitignored, only refreshed at the next release) must not
 * shadow it.
 */
export function resolveDocsRoot(): string | undefined {
	const packageRoot = cliPackageRoot();
	const candidates = [
		path.join(packageRoot, '../../apps/docs/src/content/docs'),
		path.join(packageRoot, 'docs'),
	];
	return candidates.find((candidate) => fs.existsSync(candidate));
}

function parseDocsFrontmatter(source: string): {
	data: Record<string, string>;
	body: string;
} {
	if (!source.startsWith('---\n')) return { data: {}, body: source };
	const end = source.indexOf('\n---\n', 4);
	if (end === -1) return { data: {}, body: source };

	const data: Record<string, string> = {};
	for (const line of source.slice(4, end).split('\n')) {
		const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
		const key = match?.[1];
		let value = match?.[2]?.trim();
		if (!key || value === undefined) continue;
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		data[key] = value;
	}
	return { data, body: source.slice(end + '\n---\n'.length) };
}

export function loadDocsPages(root: string): DocsPage[] {
	const pages: DocsPage[] = [];
	for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
		if (!entry.isFile() || !/\.(md|mdx)$/.test(entry.name)) continue;
		const filePath = path.join(entry.parentPath, entry.name);
		const relative = path.relative(root, filePath).split(path.sep).join('/');
		const { data, body } = parseDocsFrontmatter(fs.readFileSync(filePath, 'utf8'));
		// `foo/index.md` is addressed as `foo`, matching the website's URLs.
		const pagePath = relative.replace(/\.(md|mdx)$/, '').replace(/\/index$/, '');
		pages.push({
			path: pagePath,
			title: data.title ?? relative,
			description: data.description ?? '',
			body,
		});
	}
	return pages.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Reduces markdown/MDX source to plain text for search indexing. This is
 * intentionally a lightweight approximation: minor artifacts are acceptable
 * since the output is only used for search matching and excerpts.
 */
export function docsMarkdownToPlainText(source: string): string {
	return source
		.replace(/^(?:import|export)\s.*$/gm, '')
		.replace(/^```.*$/gm, '')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/<\/?[A-Za-z][^>]*>/g, ' ')
		.replace(/^#{1,6}\s+/gm, '')
		.replace(/^>\s?/gm, '')
		.replace(/^\s*[-*+]\s+/gm, '')
		.replace(/^\s*\d+\.\s+/gm, '')
		.replace(/^\s*---+\s*$/gm, '')
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1')
		.replace(/(^|\s)_{1,3}([^_]+)_{1,3}(?=[\s.,;:!?)]|$)/g, '$1$2')
		.replace(/\|/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
}

export function extractDocsHeadings(source: string): string {
	const matches = [...source.matchAll(/^#{2,4}\s+(.+)$/gm)];
	return matches.map((match) => docsMarkdownToPlainText(match[1] ?? '')).join(' ');
}

const DOCS_DESCRIPTION_MAX_LENGTH = 120;

export function truncateDocsDescription(description: string): string {
	const characters = [...description];
	if (characters.length <= DOCS_DESCRIPTION_MAX_LENGTH) return description;
	const truncated = characters.slice(0, DOCS_DESCRIPTION_MAX_LENGTH - 1).join('');
	const boundary = truncated.search(/\s+\S*$/u);
	return boundary > 0 ? `${truncated.slice(0, boundary)}…` : '…';
}

const DOCS_EXCERPT_RADIUS = 120;

export function buildDocsExcerpt(content: string, terms: string[]): string {
	const lowered = content.toLowerCase();
	let position = -1;
	for (const term of terms) {
		const index = lowered.indexOf(term.toLowerCase());
		if (index !== -1 && (position === -1 || index < position)) {
			position = index;
		}
	}
	if (position === -1) position = 0;

	const start = Math.max(0, position - DOCS_EXCERPT_RADIUS);
	const end = Math.min(content.length, position + DOCS_EXCERPT_RADIUS);
	const prefix = start > 0 ? '…' : '';
	const suffix = end < content.length ? '…' : '';
	return `${prefix}${content.slice(start, end).trim()}${suffix}`;
}

/** Accepts `guide/sandboxes`, `/docs/guide/sandboxes/`, full website URLs, and `.md`/`.mdx` paths. */
export function normalizeDocsPath(input: string): string {
	let value = input.trim();
	if (/^https?:\/\//.test(value)) {
		try {
			value = new URL(value).pathname;
		} catch {
			// fall through with the raw value
		}
	}
	return value
		.replace(/^\.?\/+/, '')
		.replace(/^docs\//, '')
		.replace(/\/+$/, '')
		.replace(/\.(md|mdx)$/, '')
		.replace(/\/index$/, '');
}
