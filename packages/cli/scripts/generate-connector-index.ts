#!/usr/bin/env node
/**
 * Prebuild step for `@flue/cli`.
 *
 * Reads `connectors/*.md` from the repo root, parses each file's JSON
 * frontmatter, validates it, and emits `bin/_connectors.generated.ts` so the
 * CLI has a typed in-memory index of available connectors at runtime
 * without hitting the network.
 *
 * Filename convention:
 *   <category>--<name>.md   → addressable as `flue add <name>`
 *   <category>.md           → category root, addressable as `flue add --category <category>`
 *
 * NOTE: this filename-to-slug derivation is mirrored in
 * `apps/www/src/pages/cli/connectors/[name].md.ts`. If you change the
 * filename convention here, update that route too.
 *
 * Frontmatter (JSON, fenced by `---` lines):
 *   { "category": "sandbox", "website": "https://daytona.io" }   ← named connector
 *   { "category": "sandbox", "root": true }                        ← category root
 *
 * The script aborts (non-zero exit) on:
 *   - missing/malformed frontmatter
 *   - missing required fields (`category` always; `website` for connectors)
 *   - two files resolving to the same slug
 */
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
// scripts/ → packages/cli/ → packages/ → repo root
const repoRoot = join(here, '../../..');
const connectorsDir = join(repoRoot, 'connectors');
const outFile = join(here, '../bin/_connectors.generated.ts');

interface FrontmatterCommon {
	category: string;
}
interface FrontmatterConnector extends FrontmatterCommon {
	website: string;
	root?: undefined;
}
interface FrontmatterRoot extends FrontmatterCommon {
	root: true;
}
type Frontmatter = FrontmatterConnector | FrontmatterRoot;

interface ConnectorRecord {
	slug: string;
	category: string;
	website: string;
	file: string;
}
interface CategoryRootRecord {
	category: string;
	file: string;
}

function parseFrontmatter(source: string, file: string): Frontmatter {
	if (!source.startsWith('---\n')) {
		throw new Error(`[connectors] ${file}: missing JSON frontmatter (file must start with '---').`);
	}
	const end = source.indexOf('\n---\n', 4);
	if (end < 0) {
		throw new Error(`[connectors] ${file}: frontmatter is not closed (no trailing '---').`);
	}
	const json = source.slice(4, end).trim();
	let parsed: any;
	try {
		parsed = JSON.parse(json);
	} catch (err) {
		throw new Error(
			`[connectors] ${file}: frontmatter is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	if (!parsed || typeof parsed !== 'object') {
		throw new Error(`[connectors] ${file}: frontmatter must be a JSON object.`);
	}
	if (typeof parsed.category !== 'string' || !parsed.category) {
		throw new Error(`[connectors] ${file}: frontmatter missing required string field "category".`);
	}
	if (parsed.root === true) {
		return { category: parsed.category, root: true };
	}
	if (typeof parsed.website !== 'string' || !parsed.website) {
		throw new Error(
			`[connectors] ${file}: frontmatter missing required string field "website" (or set "root": true for a category root).`,
		);
	}
	return { category: parsed.category, website: parsed.website };
}

async function main() {
	const allFiles = (await readdir(connectorsDir))
		.filter((f) => f.endsWith('.md') && f !== 'README.md')
		.sort();

	const connectors: ConnectorRecord[] = [];
	const categoryRoots: CategoryRootRecord[] = [];
	const seenSlugs = new Map<string, string>();

	for (const file of allFiles) {
		const stem = file.slice(0, -'.md'.length);
		const dashIdx = stem.indexOf('--');

		const source = await readFile(join(connectorsDir, file), 'utf-8');
		const fm = parseFrontmatter(source, file);

		if (dashIdx >= 0) {
			// Named connector: <category>--<name>.md
			if (fm.root) {
				throw new Error(
					`[connectors] ${file}: filename uses '--' separator but frontmatter has "root": true. Category roots use the bare filename "<category>.md".`,
				);
			}
			const category = stem.slice(0, dashIdx);
			const slug = stem.slice(dashIdx + 2);
			if (category !== fm.category) {
				throw new Error(
					`[connectors] ${file}: filename category "${category}" does not match frontmatter category "${fm.category}".`,
				);
			}
			if (seenSlugs.has(slug)) {
				throw new Error(
					`[connectors] slug collision: both "${seenSlugs.get(slug)}" and "${file}" resolve to slug "${slug}". Rename one.`,
				);
			}
			seenSlugs.set(slug, file);
			connectors.push({ slug, category, website: fm.website, file });
		} else {
			// Category root: <category>.md
			if (!fm.root) {
				throw new Error(
					`[connectors] ${file}: bare-named file (no '--') must declare "root": true in frontmatter.`,
				);
			}
			if (stem !== fm.category) {
				throw new Error(
					`[connectors] ${file}: filename "${stem}" does not match frontmatter category "${fm.category}". Category roots must be named "<category>.md".`,
				);
			}
			// Also use the bare slug as a reserved one so a future connector
			// named the same as a category can't shadow it.
			if (seenSlugs.has(stem)) {
				throw new Error(
					`[connectors] slug collision: "${seenSlugs.get(stem)}" already uses slug "${stem}".`,
				);
			}
			seenSlugs.set(stem, file);
			categoryRoots.push({ category: fm.category, file });
		}
	}

	const banner = `// AUTO-GENERATED by scripts/generate-connector-index.ts. Do not edit by hand.\n`;
	const connectorsLit = connectors
		.map(
			(c) =>
				`\t{ slug: ${JSON.stringify(c.slug)}, category: ${JSON.stringify(c.category)}, website: ${JSON.stringify(c.website)} },`,
		)
		.join('\n');
	const rootsLit = categoryRoots
		.map((r) => `\t{ category: ${JSON.stringify(r.category)} },`)
		.join('\n');

	// We type these as readonly arrays of the inferred element types (rather
	// than tuples via `as const`) so that `.length === 0` guards in the
	// consumer don't get narrowed to literal-type comparisons that TS flags as
	// "no overlap" when the registry currently has 1+ entries.
	const out =
		banner +
		`export const CONNECTORS: readonly { readonly slug: string; readonly category: string; readonly website: string }[] = [\n${connectorsLit}\n];\n\n` +
		`export const CATEGORY_ROOTS: readonly { readonly category: string }[] = [\n${rootsLit}\n];\n`;

	await mkdir(dirname(outFile), { recursive: true });
	await writeFile(outFile, out, 'utf-8');
	console.error(
		`[connectors] wrote ${outFile} (${connectors.length} connectors, ${categoryRoots.length} category roots)`,
	);
}

main().catch((err) => {
	console.error(err instanceof Error ? err.message : String(err));
	process.exit(1);
});
