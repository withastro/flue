import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build, createServer, type Plugin, parseAstAsync } from 'vite';
import { describe, expect, it } from 'vitest';
import { parserLangForFile } from './agent-scan.ts';
import { markdownImportPlugin } from './markdown-import-plugin.ts';

async function resolveId(plugin: Plugin, source: string, importer: string) {
	const hook = plugin.resolveId;
	if (typeof hook !== 'function') throw new Error('Expected a resolveId hook');
	return hook.call({} as never, source, importer, {} as never);
}

/** A package.json `imports` map plus the Flue markdown/skill fixture files. */
async function writeSubpathFixture(root: string): Promise<void> {
	await fs.promises.mkdir(path.join(root, 'src', 'prompts'), { recursive: true });
	await fs.promises.mkdir(path.join(root, 'src', 'skills', 'example'), { recursive: true });
	await fs.promises.writeFile(
		path.join(root, 'package.json'),
		JSON.stringify(
			{
				name: 'flue-markdown-subpath',
				private: true,
				type: 'module',
				imports: { '#src/*': './src/*' },
			},
			null,
			2,
		),
	);
	await fs.promises.writeFile(
		path.join(root, 'src', 'prompts', 'core.md'),
		'# Core prompt\n\nhello world',
	);
	await fs.promises.writeFile(
		path.join(root, 'src', 'prompts', 'relative.md'),
		'# Relative prompt\n\nrelative world',
	);
	await fs.promises.writeFile(
		path.join(root, 'src', 'skills', 'example', 'SKILL.md'),
		'---\nname: example\ndescription: An example skill.\n---\n# Example\n\nskill body',
	);
}

/** The concatenated chunk code of a single-entry lib build (write: false). */
async function bundleCode(root: string): Promise<string> {
	const result = await build({
		root,
		logLevel: 'silent',
		resolve: {
			// The virtual skill module imports `@flue/runtime/internal`;
			// point it at the built package from this repo's workspace.
			alias: {
				'@flue/runtime/internal': await import.meta.resolve('@flue/runtime/internal'),
			},
		},
		plugins: [markdownImportPlugin()],
		build: {
			write: false,
			lib: { entry: path.join(root, 'src', 'main.ts'), formats: ['es'] },
		},
	});
	const chunks = (Array.isArray(result) ? result : [result]).flatMap((bundle) => {
		if (!('output' in bundle)) return []; // build() can also return a watcher
		return bundle.output;
	});
	return chunks
		.filter((output) => output.type === 'chunk')
		.map((output) => output.code)
		.join('\n');
}

describe('markdown import parsing', () => {
	it.each([
		['view.tsx', 'tsx'],
		['view.jsx', 'jsx'],
		['view.ts', 'ts'],
		['view.js', 'js'],
	] as const)('selects the %s parser dialect', (filePath, expected) => {
		expect(parserLangForFile(filePath)).toBe(expected);
	});

	it('parses a TSX importer containing JSX and type-only imports', async () => {
		const code = `
			import type { Props } from './props';
			import instructions from './instructions.md';
			export const view = <div>{instructions}</div>;
		`;

		await expect(
			parseAstAsync(code, { lang: parserLangForFile('view.tsx') }, 'view.tsx'),
		).resolves.toBeDefined();
	});
});

describe('external skill registries', () => {
	it('delegates SKILL.md edges from the Agents SDK virtual registry', async () => {
		await expect(
			resolveId(
				markdownImportPlugin(),
				'/workspace/src/skills/example/SKILL.md',
				'\0agents:skills:/workspace/src/skills',
			),
		).resolves.toBeNull();
	});

	it('still rejects an untransformed SKILL.md edge from an ordinary importer', async () => {
		await expect(
			resolveId(
				markdownImportPlugin(),
				'/workspace/src/skills/example/SKILL.md',
				'/workspace/src/registry.js',
			),
		).rejects.toThrow('reached resolution untransformed');
	});
});

describe('subpath imports (issue #779)', () => {
	// A queried specifier is delegated to Vite by the transform, so the
	// untransformed-skill safety guard must not fire for it.
	it('rejects an untransformed subpath SKILL.md edge from an ordinary importer', async () => {
		await expect(
			resolveId(
				markdownImportPlugin(),
				'#src/skills/example/SKILL.md',
				'/workspace/src/registry.js',
			),
		).rejects.toThrow('reached resolution untransformed');
	});

	it('delegates queried subpath SKILL.md edges to Vite', async () => {
		await expect(
			resolveId(
				markdownImportPlugin(),
				'#src/skills/example/SKILL.md?raw',
				'/workspace/src/registry.js',
			),
		).resolves.toBeNull();
		await expect(
			resolveId(
				markdownImportPlugin(),
				'#src/skills/example/SKILL.md?url',
				'/workspace/src/registry.js',
			),
		).resolves.toBeNull();
	});

	// Regression: a `#src/...` import used to be dropped by the transform, so
	// Vite resolved the subpath and parsed the raw Markdown as JS — the build
	// failed with a PARSE_ERROR. Build a real Vite project whose package.json
	// maps `#src/*` to `./src/*` and assert both Flue forms are transformed.
	// `#src/skills/example/SKILL.md?url` proves Vite — not Flue's text loader —
	// owns the queried skill edge.
	it('builds #src/... .md and SKILL.md imports via a package.json imports map', async () => {
		const fixtureRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-markdown-subpath-'));
		try {
			await writeSubpathFixture(fixtureRoot);
			await fs.promises.writeFile(
				path.join(fixtureRoot, 'src', 'main.ts'),
				[
					"import core from '#src/prompts/core.md';",
					"import raw from '#src/prompts/core.md?raw';",
					"import relative from './prompts/relative.md';",
					"import skill from '#src/skills/example/SKILL.md';",
					"import skillUrl from '#src/skills/example/SKILL.md?url';",
					'console.log(core, raw, relative, skill, skillUrl);',
					'',
				].join('\n'),
			);

			const code = await bundleCode(fixtureRoot);

			// Subpath and relative .md imports both load as markdown text.
			expect(code).toContain('# Core prompt');
			expect(code).toContain('hello world');
			expect(code).toContain('# Relative prompt');
			expect(code).toContain('relative world');
			// The subpath SKILL.md import is packaged as a skill.
			expect(code).toContain('skill:example:');
			expect(code).toContain('An example skill.');
			// `#src/skills/example/SKILL.md?url` stays a Vite-native query: it is
			// inlined as a data URL rather than going through Flue's loader.
			expect(code).toContain('data:text/markdown;base64,');
		} finally {
			await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
		}
	});

	// `#` and `?` are legal in POSIX file and directory names (and `#` on
	// Windows): a resolved filesystem id must not be treated like a raw import
	// specifier. Vite resolves JavaScript from this root fine; the plugin must
	// read the Markdown files as-is instead of truncating at the `#`.
	it('keeps # in resolved filesystem paths when the project root contains it', async () => {
		const fixtureBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'flue-markdown-subpath-'));
		const fixtureRoot = path.join(fixtureBase, 'project-#-copy');
		try {
			await writeSubpathFixture(fixtureRoot);
			await fs.promises.writeFile(
				path.join(fixtureRoot, 'src', 'main.ts'),
				[
					"import core from '#src/prompts/core.md';",
					"import relative from './prompts/relative.md';",
					'console.log(core, relative);',
					'',
				].join('\n'),
			);

			const code = await bundleCode(fixtureRoot);

			expect(code).toContain('# Core prompt');
			expect(code).toContain('relative world');
		} finally {
			await fs.promises.rm(fixtureBase, { recursive: true, force: true });
		}
	});

	// The issue also reported dev failing at startup. Drive the dev module
	// graph directly: the entry transform must rewrite both subpath imports to
	// Flue's virtual modules, keep the `?raw` edge on Vite's raw loader, and
	// the markdown virtual module must load as text rather than being parsed
	// as JavaScript.
	it('serves #src/... .md and SKILL.md imports through the dev pipeline', async () => {
		const fixtureRoot = await fs.promises.mkdtemp(
			path.join(os.tmpdir(), 'flue-markdown-subpath-dev-'),
		);
		try {
			await writeSubpathFixture(fixtureRoot);
			await fs.promises.writeFile(
				path.join(fixtureRoot, 'src', 'main.ts'),
				[
					"import core from '#src/prompts/core.md';",
					"import raw from '#src/prompts/core.md?raw';",
					"import skill from '#src/skills/example/SKILL.md';",
					'console.log(core, raw, skill);',
					'',
				].join('\n'),
			);

			const server = await createServer({
				root: fixtureRoot,
				logLevel: 'silent',
				resolve: {
					alias: {
						'@flue/runtime/internal': await import.meta.resolve('@flue/runtime/internal'),
					},
				},
				plugins: [markdownImportPlugin()],
				server: {
					middlewareMode: true,
					// The fixture lives in the OS temp dir, outside Vite's default
					// file-serving root; allow it (realpath'd, since the tmpdir is
					// reached through /var -> /private/var on macOS).
					fs: { allow: [fs.realpathSync(fixtureRoot)] },
				},
			});
			try {
				const entry = await server.transformRequest('/src/main.ts');
				expect(entry?.code).toBeDefined();
				// The .md import was rewritten to Flue's markdown virtual module
				// (`\0` is URL-encoded as __x00__ in dev ids)...
				expect(entry?.code).toContain('__x00__flue-markdown:');
				// ...the SKILL.md import to Flue's packaged-skill module...
				expect(entry?.code).toContain('__x00__flue-skill:');
				// ...and the `?raw` edge stayed on Vite's raw loader.
				expect(entry?.code).toContain('&raw');

				// The virtual markdown module loads as text, not as JS.
				const markdownModule = await server.transformRequest(
					`\0flue-markdown:${path.join(fixtureRoot, 'src', 'prompts', 'core.md')}`,
				);
				expect(markdownModule?.code).toContain('export default');
				expect(markdownModule?.code).toContain('# Core prompt');
				expect(markdownModule?.code).toContain('hello world');
			} finally {
				await server.close();
			}
		} finally {
			await fs.promises.rm(fixtureRoot, { recursive: true, force: true });
		}
	});
});
