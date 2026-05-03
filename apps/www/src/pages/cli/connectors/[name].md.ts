/**
 * Serves connector instructions for `flue add <name>` and
 * `flue add <url> --category <name>`.
 *
 * Source-of-truth files live at the repo's top-level `connectors/` directory.
 * Filename convention: `<category>--<name>.md` for connectors,
 * `<category>.md` (with `"root": true` frontmatter) for category roots.
 *
 * Slug resolution:
 * - For a request like `/cli/connectors/daytona.md`, we look for any file of
 *   the form `*--daytona.md` first, then fall back to `daytona.md` (used
 *   only by category roots).
 * - For a request like `/cli/connectors/sandbox.md` where `sandbox.md` is a
 *   category root, the bare-filename match handles it.
 *
 * The route strips the JSON frontmatter before serving so the body is what
 * the agent (or user) actually consumes.
 *
 * NOTE: this filename-to-slug derivation is mirrored in
 * `packages/cli/scripts/generate-connector-index.ts`. If you change the
 * filename convention here, update that script too.
 */
import type { APIRoute, GetStaticPaths } from 'astro';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const connectorsDir = join(repoRoot, 'connectors');

interface ConnectorEntry {
	slug: string;
	file: string;
}

async function listConnectorEntries(): Promise<ConnectorEntry[]> {
	const files = (await readdir(connectorsDir)).filter((f) => f.endsWith('.md') && f !== 'README.md');
	const entries: ConnectorEntry[] = [];
	for (const file of files) {
		const stem = file.slice(0, -'.md'.length);
		const dashIdx = stem.indexOf('--');
		if (dashIdx >= 0) {
			// `sandbox--daytona.md` → slug `daytona`
			entries.push({ slug: stem.slice(dashIdx + 2), file });
		} else {
			// `sandbox.md` → slug `sandbox` (category root, addressable via the
			// category name)
			entries.push({ slug: stem, file });
		}
	}
	return entries;
}

export const getStaticPaths: GetStaticPaths = async () => {
	const entries = await listConnectorEntries();
	return entries.map(({ slug }) => ({ params: { name: slug } }));
};

function stripFrontmatter(source: string): string {
	if (!source.startsWith('---\n')) return source;
	const end = source.indexOf('\n---\n', 4);
	if (end < 0) return source;
	return source.slice(end + '\n---\n'.length).replace(/^\n+/, '');
}

export const GET: APIRoute = async ({ params }) => {
	const name = params.name;
	if (!name) {
		return new Response('Not found', { status: 404 });
	}

	const entries = await listConnectorEntries();
	const entry = entries.find((e) => e.slug === name);
	if (!entry) {
		return new Response(`Connector "${name}" not found.`, {
			status: 404,
			headers: { 'Content-Type': 'text/plain; charset=utf-8' },
		});
	}

	const raw = await readFile(join(connectorsDir, entry.file), 'utf-8');
	const body = stripFrontmatter(raw);

	return new Response(body, {
		headers: {
			'Content-Type': 'text/markdown; charset=utf-8',
		},
	});
};
