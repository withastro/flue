import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { packageUpSync } from 'package-up';
import { CloudflarePlugin } from './build-plugin-cloudflare.ts';
import { NodePlugin } from './build-plugin-node.ts';
import { bundleSkillImports } from './skill-bundle.ts';
import type {
	AgentInfo,
	BuildContext,
	BuildOptions,
	BuildPlugin,
} from './types.ts';

interface ParsedAgentFile {
	channelNames: string[];
}

/** Extract static agent metadata at build time without evaluating the agent module. */
function parseAgentFile(filePath: string): ParsedAgentFile {
	return { channelNames: parseChannelNames(filePath) };
}

function parseChannelNames(filePath: string): string[] {
	const source = fs.readFileSync(filePath, 'utf-8');
	const ast = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForFile(filePath),
	);
	let channelNames: string[] | undefined;

	for (const statement of ast.statements) {
		if (isTriggersReExport(statement) || hasTriggersExport(statement)) {
			throwUnsupportedTriggers(filePath, 'triggers are no longer supported; export channels instead');
		}
		if (isChannelsReExport(statement)) {
			throwUnsupportedChannels(filePath, 're-exported channels are not supported');
		}
		if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;
		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'channels') continue;
			if (channelNames) throwUnsupportedChannels(filePath, 'multiple channels exports were found');
			if (!declaration.initializer) throwUnsupportedChannels(filePath, 'missing initializer');
			channelNames = parseChannelsInitializer(filePath, declaration.initializer);
		}
	}

	return channelNames ?? [];
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
	if (/\.m?js$/.test(filePath)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
}

function hasExportModifier(statement: ts.VariableStatement): boolean {
	return statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

function isTriggersReExport(statement: ts.Statement): boolean {
	if (!ts.isExportDeclaration(statement) || !statement.exportClause) return false;
	if (!ts.isNamedExports(statement.exportClause)) return false;
	return statement.exportClause.elements.some((element) => element.name.text === 'triggers');
}

function hasTriggersExport(statement: ts.Statement): boolean {
	if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) return false;
	return statement.declarationList.declarations.some(
		(declaration) => ts.isIdentifier(declaration.name) && declaration.name.text === 'triggers',
	);
}

function isChannelsReExport(statement: ts.Statement): boolean {
	if (!ts.isExportDeclaration(statement) || !statement.exportClause) return false;
	if (!ts.isNamedExports(statement.exportClause)) return false;
	return statement.exportClause.elements.some((element) => element.name.text === 'channels');
}

function parseChannelsInitializer(filePath: string, initializer: ts.Expression): string[] {
	const expr = unwrapExpression(initializer);
	if (!ts.isArrayLiteralExpression(expr)) {
		throwUnsupportedChannels(filePath, 'expected a static array literal');
	}
	const channelNames: string[] = [];
	for (const element of expr.elements) {
		const item = unwrapExpression(element);
		if (!ts.isCallExpression(item)) continue;
		const callee = unwrapExpression(item.expression);
		if (ts.isIdentifier(callee) && !channelNames.includes(callee.text)) {
			channelNames.push(callee.text);
		}
	}
	return channelNames;
}

function unwrapExpression(expr: ts.Expression): ts.Expression {
	while (
		ts.isAsExpression(expr) ||
		ts.isSatisfiesExpression(expr) ||
		ts.isTypeAssertionExpression(expr) ||
		ts.isParenthesizedExpression(expr)
	) {
		expr = expr.expression;
	}
	return expr;
}

function throwUnsupportedTriggers(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported triggers export in ${filePath}: ${reason}. ` +
			'Use channels instead, for example: export const channels = [http()].',
	);
}

function throwUnsupportedChannels(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported channels export in ${filePath}: ${reason}. ` +
			'Use a static array literal, for example: export const channels = [http()].',
	);
}

/**
 * Result returned by {@link build}. `changed` indicates whether any file in
 * `dist/` was actually modified. Callers (notably the dev server) use this to
 * skip restarting downstream processes for no-op rebuilds on agent body edits.
 */
export interface BuildResult {
	changed: boolean;
}

/**
 * Build a project into a deployable artifact.
 *
 * `options.root` is the project root — typically the user's cwd. Source files
	 * agents are discovered from one of two locations inside the root,

 * with the same precedence rule the CLI uses:
 *
 *   - If `<root>/.flue/` exists, it is the source root. Look for
 *     `.flue/agents/`. The bare `<root>/agents/` is ignored entirely.
 *   - Otherwise, look at `<root>/agents/`.
 *
 * Build output lands in `options.output` (defaults to `<root>/dist`).
 *
 * AGENTS.md and .agents/skills/ are NOT bundled — discovered at runtime from session cwd.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
	const root = path.resolve(options.root);
	const output = path.resolve(options.output ?? path.join(root, 'dist'));

	const plugin = resolvePlugin(options);

	const sourceRoot = resolveSourceRoot(root);

	console.log(`[flue] Building: ${root}`);
	if (sourceRoot !== root) {
		console.log(`[flue] Source root: ${sourceRoot}`);
	}
	console.log(`[flue] Output: ${output}`);
	console.log(`[flue] Target: ${plugin.name}`);

	const agents = discoverAgents(sourceRoot);
	const appEntry = discoverAppEntry(sourceRoot);

	if (agents.length === 0) {
		throw new Error(
			`[flue] No agent files found.\n\n` +
				`Expected at: ${path.join(sourceRoot, 'agents')}/\n` +
				`Add at least one agent file (e.g. hello.ts).`,
		);
	}

	if (appEntry) {
		console.log(`[flue] Custom app entry: ${path.relative(root, appEntry) || appEntry}`);
	}

	const deployableAgents = agents.filter((a) => a.channelNames.length > 0);
	const excludedAgents = agents.filter((a) => a.channelNames.length === 0);

	console.log(`[flue] Found ${agents.length} agent(s): ${agents.map((a) => a.name).join(', ')}`);
	if (deployableAgents.length > 0) {
		console.log(
			`[flue] Channel agents: ${deployableAgents.map((a) => `${a.name} (${a.channelNames.join(', ')})`).join(', ')}`,
		);
	}
	if (excludedAgents.length > 0) {
		console.log(
			`[flue] Excluded agents (no channels export): ${excludedAgents.map((a) => a.name).join(', ')}`,
		);
	}
	console.log(
		`[flue] AGENTS.md and .agents/skills/ will be discovered at runtime from session cwd`,
	);

	fs.mkdirSync(output, { recursive: true });

	const manifest = {
		agents: deployableAgents.map((a) => ({
			name: a.name,
			channels: a.channelNames,
		})),
	};
	const manifestPath = path.join(output, 'manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	console.log(`[flue] Generated: ${manifestPath}`);

	const ctx: BuildContext = {
		agents,
		manifest,
		root,
		output,
		appEntry,
		runtimeVersion: readRuntimeVersion(root),
		options,
	};

	const serverCode = await plugin.generateEntryPoint(ctx);
	const bundleStrategy = plugin.bundle ?? 'esbuild';
	let anyChanged = false;

	if (bundleStrategy === 'esbuild') {
		// Single-bundle mode: the plugin produces a TS entry, esbuild
		// inlines/externalizes deps, output is server.mjs in the build dir.
		const entryPath = path.join(output, '_entry_server.ts');
		const bundledEntryPath = path.join(output, '_entry_server.bundled.js');
		const outPath = path.join(output, 'server.mjs');

		fs.writeFileSync(entryPath, serverCode, 'utf-8');
		await bundleSkillImports(entryPath, bundledEntryPath);

		try {
			const nodePathsSet = collectNodePaths(root);
			const { external: pluginExternal = [], ...pluginEsbuildOpts } = plugin.esbuildOptions
				? plugin.esbuildOptions(ctx)
				: {};

			// User's direct deps are externalized (resolved at runtime); Flue infra gets bundled
			const userExternals = getUserExternals(root);

			await esbuild.build({
				entryPoints: [bundledEntryPath],
				bundle: true,
				outfile: outPath,
				format: 'esm',
				external: [...pluginExternal, ...userExternals],
				nodePaths: [...nodePathsSet],
				logLevel: 'warning',
				loader: { '.ts': 'ts', '.node': 'empty' },
				treeShaking: true,
				sourcemap: true,
				...pluginEsbuildOpts,
			});
			console.log(`[flue] Built: ${outPath}`);
			// esbuild always writes; we treat this path as "changed" without
			// trying to compute byte-equality across reloads.
			anyChanged = true;
		} finally {
			try {
				fs.unlinkSync(entryPath);
			} catch {
				/* ignore */
			}
			try {
				fs.unlinkSync(bundledEntryPath);
			} catch {
				/* ignore */
			}
		}
	} else if (bundleStrategy === 'none') {
		// Pass-through mode: write the entry as-is. A downstream tool (e.g.
		// wrangler) handles bundling. We don't even glance at `esbuildOptions`.
		if (!plugin.entryFilename) {
			throw new Error(
				`[flue] Plugin "${plugin.name}" set bundle: 'none' but did not provide entryFilename.`,
			);
		}
		const outPath = path.join(output, plugin.entryFilename);
		const bundledOutPath = outPath.replace(/\.(ts|js|mts|mjs)$/i, '.bundled.js');
		// Skip the write if content is byte-identical to what's already on
		// disk. This matters for `flue dev`, where downstream watchers (like
		// wrangler's bundler) may key on file mtime and would otherwise reload
		// the worker for a no-op rebuild on agent body edits.
		const writeIfChanged =
			!fs.existsSync(outPath) || fs.readFileSync(outPath, 'utf-8') !== serverCode;
		if (writeIfChanged) {
			fs.writeFileSync(outPath, serverCode, 'utf-8');
			console.log(`[flue] Wrote entry: ${outPath} (no bundle — downstream tool handles it)`);
			anyChanged = true;
		} else {
			console.log(`[flue] Entry unchanged: ${outPath}`);
		}
		await bundleSkillImports(outPath, bundledOutPath);
	} else {
		throw new Error(`[flue] Unknown bundle strategy: ${bundleStrategy}`);
	}

	if (plugin.additionalOutputs) {
		const outputs = await plugin.additionalOutputs(ctx);
		for (const [filename, content] of Object.entries(outputs)) {
			const filePath = path.join(output, filename);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			// As with the entry above: avoid touching the file if content is
			// unchanged so downstream watchers (e.g. wrangler) don't see
			// spurious mtime updates and reload for no reason.
			const changed =
				!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8') !== content;
			if (changed) {
				fs.writeFileSync(filePath, content, 'utf-8');
				console.log(`[flue] Generated: ${filePath}`);
				anyChanged = true;
			}
		}
	}

	console.log(`[flue] Build complete. Output: ${output}`);
	return { changed: anyChanged };
}

function resolvePlugin(options: BuildOptions): BuildPlugin {
	if (options.plugin) return options.plugin;

	if (!options.target) {
		throw new Error(
			'[flue] No build target specified. Use --target to choose a target:\n' +
				'  flue build --target node\n' +
				'  flue build --target cloudflare',
		);
	}

	switch (options.target) {
		case 'node':
			return new NodePlugin();
		case 'cloudflare':
			return new CloudflarePlugin();
		default:
			throw new Error(
				`[flue] Unknown target: "${options.target}". Supported targets: node, cloudflare`,
			);
	}
}

/**
 * Resolve the source root for a project, using the `.flue/`-as-src
 * convention (analogous to Next.js's `src/` folder).
 *
 * If `<root>/.flue/` exists, it is the source root. Otherwise the source root
 * is the project root itself. The two layouts never mix — if `.flue/` exists,
 * the bare layout is ignored entirely (even if a `<root>/agents/` directory
 * also happens to be present).
 *
 * The project root (cwd) stays the same in both cases — `.flue/` only shifts
 * where source files are discovered from. The build output directory is
 * independent (defaults to `<root>/dist`, override with `output`).
 */
export function resolveSourceRoot(root: string): string {
	const dotFlue = path.join(root, '.flue');
	if (fs.existsSync(dotFlue)) return dotFlue;
	return root;
}

function discoverAgents(sourceRoot: string): AgentInfo[] {
	const agentsDir = path.join(sourceRoot, 'agents');
	if (!fs.existsSync(agentsDir)) return [];

	return fs
		.readdirSync(agentsDir)
		.filter((f) => /\.(ts|js|mts|mjs)$/.test(f))
		.map((f) => {
			const filePath = path.join(agentsDir, f);
			const { channelNames } = parseAgentFile(filePath);
			return {
				name: f.replace(/\.(ts|js|mts|mjs)$/, ''),
				filePath,
				channelNames,
			};
		});
}

/**
 * Discover an optional `app.{ts,mts,js,mjs}` entry alongside `agents/`.
 * Returns the absolute path to the first match found, or
 * undefined when no app entry is present.
 *
 * Extension priority matches {@link discoverAgents}: `.ts` > `.mts`
 * > `.js` > `.mjs`. Source-files-only — we don't probe inside the
 * the `agents/` subdir.
 */
function discoverAppEntry(sourceRoot: string): string | undefined {
	for (const ext of ['ts', 'mts', 'js', 'mjs']) {
		const candidate = path.join(sourceRoot, `app.${ext}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

/** Externalize user's direct deps (bare name + subpath wildcard). */
function getUserExternals(root: string): string[] {
	const pkgPath = packageUpSync({ cwd: root });
	if (!pkgPath) return [];

	try {
		const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
		const deps = Object.keys({
			...pkg.dependencies,
			...pkg.devDependencies,
			...pkg.peerDependencies,
		});
		return deps.flatMap((name) => [name, `${name}/*`]);
	} catch {
		return [];
	}
}

function collectNodePaths(root: string): Set<string> {
	const nodePathsSet = new Set<string>();
	// Walk up from the project root (user's deps), the CLI's own location
	// (in case the build needs CLI-bundled helpers), and `@flue/runtime`'s
	// install location as resolved from the project. The latter is what
	// surfaces the runtime deps (`@hono/node-server`, `hono`, `pi-ai`,
	// etc.) that the generated `server.mjs` imports — `@flue/runtime` is the
	// package that lists them, so esbuild has to be able to reach its
	// `node_modules/` subtree.
	const seeds = [root, getCLIDir()];
	const runtimeDir = resolveRuntimeDir(root);
	if (runtimeDir) seeds.push(runtimeDir);
	for (const startDir of seeds) {
		let dir = startDir;
		while (dir !== path.dirname(dir)) {
			const nm = path.join(dir, 'node_modules');
			if (fs.existsSync(nm)) nodePathsSet.add(nm);
			dir = path.dirname(dir);
		}
	}
	return nodePathsSet;
}

function readRuntimeVersion(root: string): string {
	const runtimeDir = resolveRuntimeDir(root);
	if (!runtimeDir) return '0.0.0';
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'package.json'), 'utf-8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
	} catch {
		return '0.0.0';
	}
}

function getCLIDir(): string {
	try {
		return path.dirname(new URL(import.meta.url).pathname);
	} catch {
		return __dirname;
	}
}

/**
 * Resolve the install directory of `@flue/runtime` as seen from the project
 * `root`. We walk up from `root` looking for `node_modules/@flue/runtime` —
 * `require.resolve` would be cleaner, but `@flue/runtime`'s `package.json`
 * isn't part of the package's `exports` map and its subpaths are
 * ESM-only, both of which trip up `createRequire`. Walking the
 * `node_modules` chain is what npm/pnpm/yarn all do internally for
 * resolution anyway. Returns the package directory, or `undefined` if
 * the project doesn't have `@flue/runtime` installed yet.
 */
function resolveRuntimeDir(root: string): string | undefined {
	let dir = root;
	while (dir !== path.dirname(dir)) {
		const candidate = path.join(dir, 'node_modules', '@flue', 'runtime');
		if (fs.existsSync(candidate)) return candidate;
		dir = path.dirname(dir);
	}
	return undefined;
}
