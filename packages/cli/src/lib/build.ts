import * as esbuild from 'esbuild';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ts from 'typescript';
import { packageUpSync } from 'package-up';
import { parseFrontmatterFile } from '@flue/runtime/internal';
import { CloudflarePlugin } from './build-plugin-cloudflare.ts';
import { NodePlugin } from './build-plugin-node.ts';
import type { Role, ThinkingLevel } from '@flue/runtime';
import type {
	AgentInfo,
	BuildContext,
	BuildOptions,
	BuildPlugin,
} from './types.ts';

interface ParsedAgentFile {
	triggers: {
		webhook?: boolean;
	};
}

/** Extract static agent metadata at build time without evaluating the agent module. */
function parseAgentFile(filePath: string): ParsedAgentFile {
	return {
		triggers: parseTriggers(filePath),
	};
}

function parseTriggers(filePath: string): ParsedAgentFile['triggers'] {
	const source = fs.readFileSync(filePath, 'utf-8');
	const ast = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForFile(filePath),
	);
	let result: ParsedAgentFile['triggers'] | undefined;

	for (const statement of ast.statements) {
		if (isTriggersReExport(statement)) {
			throwUnsupportedTriggers(filePath, 're-exported triggers are not supported');
		}
		if (!ts.isVariableStatement(statement) || !hasExportModifier(statement)) continue;

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'triggers') continue;
			if (result) throwUnsupportedTriggers(filePath, 'multiple triggers exports were found');
			if (!declaration.initializer) throwUnsupportedTriggers(filePath, 'missing initializer');
			result = parseTriggersInitializer(filePath, declaration.initializer);
		}
	}

	return result ?? {};
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

function parseTriggersInitializer(
	filePath: string,
	initializer: ts.Expression,
): ParsedAgentFile['triggers'] {
	const expr = unwrapExpression(initializer);
	if (!ts.isObjectLiteralExpression(expr)) {
		throwUnsupportedTriggers(filePath, 'expected a static object literal');
	}

	const result: ParsedAgentFile['triggers'] = {};
	for (const property of expr.properties) {
		if (ts.isSpreadAssignment(property)) {
			throwUnsupportedTriggers(filePath, 'spread properties are not supported');
		}
		if (ts.isShorthandPropertyAssignment(property)) {
			const name = property.name.text;
			if (name === 'webhook') {
				throwUnsupportedTriggers(filePath, `"${name}" must use an explicit static value`);
			}
			continue;
		}
		if (!ts.isPropertyAssignment(property)) {
			const name = propertyNameText(filePath, property.name);
			if (name === 'webhook') {
				throwUnsupportedTriggers(filePath, `"${name}" must use an explicit static value`);
			}
			continue;
		}

		const name = propertyNameText(filePath, property.name);
		if (name === 'webhook') {
			const value = unwrapExpression(property.initializer);
			if (value.kind === ts.SyntaxKind.TrueKeyword) result.webhook = true;
			else if (value.kind === ts.SyntaxKind.FalseKeyword) delete result.webhook;
			else throwUnsupportedTriggers(filePath, '"webhook" must be true or false');
		}
	}

	return result;
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

function propertyNameText(filePath: string, name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}

	if (ts.isComputedPropertyName(name)) {
		const expression = unwrapExpression(name.expression);
		if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
			return expression.text;
		}
		throwUnsupportedTriggers(filePath, 'computed property names must be static');
	}

	return undefined;
}

function throwUnsupportedTriggers(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported triggers export in ${filePath}: ${reason}. ` +
			'Use a static object literal, for example: export const triggers = { webhook: true }.',
	);
}

// Exhaustive list of valid thinking levels. The `satisfies` clause ensures this
// stays in lockstep with `ThinkingLevel` from pi-agent-core: if a level is added
// or removed upstream, this assignment fails to type-check.
const VALID_THINKING_LEVELS = {
	off: true,
	minimal: true,
	low: true,
	medium: true,
	high: true,
	xhigh: true,
} as const satisfies Record<ThinkingLevel, true>;

function parseThinkingLevel(value: string | undefined, source: string): ThinkingLevel | undefined {
	if (value === undefined) return undefined;
	const normalized = value.trim();
	if (!normalized) return undefined;
	if (!(normalized in VALID_THINKING_LEVELS)) {
		throw new Error(
			`[flue] Invalid thinkingLevel ${JSON.stringify(value)} in ${source}. ` +
				`Expected one of: ${Object.keys(VALID_THINKING_LEVELS).join(', ')}.`,
		);
	}
	return normalized as ThinkingLevel;
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
 * (agents, roles) are discovered from one of two locations inside the root,
 * with the same precedence rule the CLI uses:
 *
 *   - If `<root>/.flue/` exists, it is the source root. Look for
 *     `.flue/agents/` and `.flue/roles/`. The bare `<root>/agents/` and
 *     `<root>/roles/` are ignored entirely (no mixing).
 *   - Otherwise, look at `<root>/agents/` and `<root>/roles/`.
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

	const roles = discoverRoles(sourceRoot);
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

	// NOTE: agents without triggers are valid. They aren't exposed as HTTP
	// routes in deployed builds, but the `flue run` CLI can still invoke them
	// locally (see FLUE_MODE=local in the Node plugin). This supports the
	// "CI-only agent" pattern documented in the README.
	const webhookAgents = agents.filter((a) => a.triggers.webhook);
	const triggerlessAgents = agents.filter((a) => !a.triggers.webhook);

	console.log(
		`[flue] Found ${Object.keys(roles).length} role(s): ${Object.keys(roles).join(', ') || '(none)'}`,
	);
	console.log(`[flue] Found ${agents.length} agent(s): ${agents.map((a) => a.name).join(', ')}`);
	if (webhookAgents.length > 0) {
		console.log(`[flue] Webhook agents: ${webhookAgents.map((a) => a.name).join(', ')}`);
	}
	if (triggerlessAgents.length > 0) {
		console.log(
			`[flue] CLI-only agents (no HTTP route in deployed build): ${triggerlessAgents.map((a) => a.name).join(', ')}`,
		);
	}
	console.log(
		`[flue] AGENTS.md and .agents/skills/ will be discovered at runtime from session cwd`,
	);

	fs.mkdirSync(output, { recursive: true });

	const manifest = {
		agents: agents.map((a) => ({
			name: a.name,
			triggers: a.triggers,
		})),
	};
	const manifestPath = path.join(output, 'manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	console.log(`[flue] Generated: ${manifestPath}`);

	const ctx: BuildContext = {
		agents,
		manifest,
		roles,
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
		const outPath = path.join(output, 'server.mjs');

		fs.writeFileSync(entryPath, serverCode, 'utf-8');

		try {
			const nodePathsSet = collectNodePaths(root);
			const { external: pluginExternal = [], ...pluginEsbuildOpts } = plugin.esbuildOptions
				? plugin.esbuildOptions(ctx)
				: {};

			// User's direct deps are externalized (resolved at runtime); Flue infra gets bundled
			const userExternals = getUserExternals(root);

			await esbuild.build({
				entryPoints: [entryPath],
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

function discoverRoles(sourceRoot: string): Record<string, Role> {
	const rolesDir = path.join(sourceRoot, 'roles');
	if (!fs.existsSync(rolesDir)) return {};

	const roles: Record<string, Role> = {};

	for (const entry of fs.readdirSync(rolesDir)) {
		if (!/\.(md|markdown)$/i.test(entry)) continue;

		const filePath = path.join(rolesDir, entry);
		const content = fs.readFileSync(filePath, 'utf-8');
		const name = entry.replace(/\.(md|markdown)$/i, '');
		const parsed = parseFrontmatterFile(content, name);
		const thinkingLevel = parseThinkingLevel(
			parsed.frontmatter.thinkingLevel,
			`role "${name}" frontmatter`,
		);
		roles[name] = {
			name,
			description: parsed.description,
			instructions: parsed.body,
			model: parsed.frontmatter.model,
			thinkingLevel,
		};
	}

	return roles;
}

function discoverAgents(sourceRoot: string): AgentInfo[] {
	const agentsDir = path.join(sourceRoot, 'agents');
	if (!fs.existsSync(agentsDir)) return [];

	return fs
		.readdirSync(agentsDir)
		.filter((f) => /\.(ts|js|mts|mjs)$/.test(f))
		.map((f) => {
			const filePath = path.join(agentsDir, f);
			const { triggers } = parseAgentFile(filePath);
			return {
				name: f.replace(/\.(ts|js|mts|mjs)$/, ''),
				filePath,
				triggers,
			};
		});
}

/**
 * Discover an optional `app.{ts,mts,js,mjs}` entry alongside `agents/`
 * and `roles/`. Returns the absolute path to the first match found, or
 * undefined when no app entry is present.
 *
 * Extension priority matches {@link discoverAgents}: `.ts` > `.mts`
 * > `.js` > `.mjs`. Source-files-only — we don't probe inside the
 * `agents/` or `roles/` subdirs.
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
