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
	WorkflowInfo,
} from './types.ts';

interface ParsedAgentFile {
	channels?: Record<string, true>;
	hasReceive: boolean;
	hasInit: boolean;
}

interface ParsedWorkflowFile {
	channels: {
		http?: boolean;
		websocket?: boolean;
	};
}

/** Extract static agent metadata at build time without evaluating the agent module. */
function parseAgentFile(filePath: string): ParsedAgentFile {
	const source = fs.readFileSync(filePath, 'utf-8');
	const ast = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForFile(filePath),
	);
	let channels: ParsedAgentFile['channels'];
	let hasReceive = false;
	let hasInit = false;

	for (const statement of ast.statements) {
		if (isDefaultExport(statement)) {
			throwUnsupportedAgentExports(filePath, 'default exports are not supported');
		}

		if (ts.isExportDeclaration(statement)) {
			throwUnsupportedAgentExportDeclaration(filePath, statement);
		}

		if (!isExportedDeclaration(statement)) continue;

		if (ts.isFunctionDeclaration(statement)) {
			const name = statement.name?.text;
			if (!name) throwUnsupportedAgentExports(filePath, 'anonymous exports are not supported');
			if (name !== 'receive' && name !== 'init') {
				throwUnsupportedAgentExports(filePath, `unsupported named export "${name}"`);
			}
			if (!hasModifier(statement, ts.SyntaxKind.AsyncKeyword)) {
				throwUnsupportedAgentExports(filePath, `"${name}" must be async`);
			}
			if (name === 'receive') {
				if (hasReceive) throwUnsupportedAgentExports(filePath, 'multiple "receive" exports were found');
				hasReceive = true;
			} else {
				if (hasInit) throwUnsupportedAgentExports(filePath, 'multiple "init" exports were found');
				hasInit = true;
			}
			continue;
		}

		if (!ts.isVariableStatement(statement)) {
			if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
				throwUnsupportedAgentExports(filePath, 'type-only exports are not supported');
			}
			const name = declarationName(statement);
			if (name) throwUnsupportedAgentExports(filePath, `unsupported named export "${name}"`);
			throwUnsupportedAgentExports(filePath, 'unsupported exported declaration');
		}

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) {
				throwUnsupportedAgentExports(filePath, 'destructured agent exports are not supported');
			}
			const name = declaration.name.text;
			if (name !== 'channels') {
				throwUnsupportedAgentExports(filePath, `unsupported named export "${name}"`);
			}
			if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
				throwUnsupportedAgentChannels(filePath, 'channels must be declared with export const');
			}
			if (channels) throwUnsupportedAgentChannels(filePath, 'multiple channels exports were found');
			if (!declaration.initializer) throwUnsupportedAgentChannels(filePath, 'missing initializer');
			channels = parseAgentChannelsInitializer(filePath, declaration.initializer);
		}
	}

	if (channels && !hasReceive) {
		throwUnsupportedAgentExports(filePath, 'external-channel agents must export "receive"');
	}
	if (channels && !hasInit) {
		throwUnsupportedAgentExports(filePath, 'external-channel agents must export "init"');
	}
	if (!channels && hasReceive) {
		throwUnsupportedAgentExports(filePath, '"receive" requires a "channels" export');
	}
	if (!channels && hasInit) {
		throwUnsupportedAgentExports(filePath, '"init" requires a "channels" export in Phase 1');
	}

	return { channels, hasReceive, hasInit };
}

function parseWorkflowFile(filePath: string): ParsedWorkflowFile {
	const source = fs.readFileSync(filePath, 'utf-8');
	const ast = ts.createSourceFile(
		filePath,
		source,
		ts.ScriptTarget.Latest,
		true,
		scriptKindForFile(filePath),
	);
	let hasRun = false;
	let channels: ParsedWorkflowFile['channels'] | undefined;

	for (const statement of ast.statements) {
		if (isDefaultExport(statement)) {
			throwUnsupportedWorkflowExports(filePath, 'default exports are not supported');
		}

		if (ts.isExportDeclaration(statement)) {
			throwUnsupportedWorkflowExportDeclaration(filePath, statement);
		}

		if (!isExportedDeclaration(statement)) continue;

		if (ts.isFunctionDeclaration(statement)) {
			const name = statement.name?.text;
			if (!name) throwUnsupportedWorkflowExports(filePath, 'anonymous exports are not supported');
			if (name !== 'run') {
				throwUnsupportedWorkflowExports(filePath, `unsupported named export "${name}"`);
			}
			if (!hasModifier(statement, ts.SyntaxKind.AsyncKeyword)) {
				throwUnsupportedWorkflowRun(filePath, '"run" must be async');
			}
			if (hasRun) throwUnsupportedWorkflowRun(filePath, 'multiple "run" exports were found');
			hasRun = true;
			continue;
		}

		if (!ts.isVariableStatement(statement)) {
			if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) {
				throwUnsupportedWorkflowExports(filePath, 'type-only exports are not supported');
			}
			const name = declarationName(statement);
			if (name === 'run') {
				throwUnsupportedWorkflowRun(filePath, '"run" must be a direct exported async function declaration');
			}
			if (name) {
				throwUnsupportedWorkflowExports(filePath, `unsupported named export "${name}"`);
			}
			throwUnsupportedWorkflowExports(filePath, 'unsupported exported declaration');
		}

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name)) {
				throwUnsupportedWorkflowExports(filePath, 'destructured workflow exports are not supported');
			}
			const name = declaration.name.text;
			if (name === 'run') {
				throwUnsupportedWorkflowRun(filePath, '"run" must be a direct exported async function declaration');
			}
			if (name !== 'channels') {
				throwUnsupportedWorkflowExports(filePath, `unsupported named export "${name}"`);
			}
			if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) {
				throwUnsupportedWorkflowChannels(filePath, 'channels must be declared with export const');
			}
			if (channels) throwUnsupportedWorkflowChannels(filePath, 'multiple channels exports were found');
			if (!declaration.initializer) throwUnsupportedWorkflowChannels(filePath, 'missing initializer');
			channels = parseWorkflowChannelsInitializer(filePath, declaration.initializer);
		}
	}

	if (!hasRun) {
		throwUnsupportedWorkflowRun(filePath, 'required direct export "export async function run(...)" was not found');
	}
	return { channels: channels ?? {} };
}

function parseWorkflowChannelsInitializer(
	filePath: string,
	initializer: ts.Expression,
): ParsedWorkflowFile['channels'] {
	const expr = unwrapExpression(initializer);
	if (!ts.isArrayLiteralExpression(expr)) {
		throwUnsupportedWorkflowChannels(filePath, 'expected a static factory array');
	}

	const result: ParsedWorkflowFile['channels'] = {};
	for (const element of expr.elements) {
		if (ts.isOmittedExpression(element)) {
			throwUnsupportedWorkflowChannels(filePath, 'omitted array entries are not supported');
		}

		const channel = parseWorkflowChannelFactory(filePath, element);
		result[channel] = true;
	}

	return result;
}

function parseWorkflowChannelFactory(
	filePath: string,
	element: ts.Expression,
): keyof ParsedWorkflowFile['channels'] {
	const expr = unwrapExpression(element);
	if (!ts.isCallExpression(expr)) {
		throwUnsupportedWorkflowChannels(filePath, 'channel entries must be direct http() or websocket() calls');
	}
	if (expr.arguments.length > 0) {
		throwUnsupportedWorkflowChannels(filePath, 'channel factory calls must not receive arguments');
	}
	if (!ts.isIdentifier(expr.expression)) {
		throwUnsupportedWorkflowChannels(filePath, 'channel factories must be direct http() or websocket() calls');
	}

	const name = expr.expression.text;
	if (name !== 'http' && name !== 'websocket') {
		throwUnsupportedWorkflowChannels(filePath, `unsupported channel factory "${name}()"`);
	}

	return name;
}

function isDefaultExport(statement: ts.Statement): boolean {
	if (ts.isExportAssignment(statement)) return true;
	return hasModifier(statement, ts.SyntaxKind.ExportKeyword) && hasModifier(statement, ts.SyntaxKind.DefaultKeyword);
}

function isExportedDeclaration(statement: ts.Statement): boolean {
	return hasModifier(statement, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(statement: ts.Statement, kind: ts.SyntaxKind): boolean {
	if (!ts.canHaveModifiers(statement)) return false;
	return ts.getModifiers(statement)?.some((modifier) => modifier.kind === kind) ?? false;
}

function throwUnsupportedWorkflowExportDeclaration(
	filePath: string,
	statement: ts.ExportDeclaration,
): never {
	if (statement.isTypeOnly) {
		throwUnsupportedWorkflowExports(filePath, 'type-only exports are not supported');
	}
	if (statement.moduleSpecifier) {
		throwUnsupportedWorkflowExports(filePath, 're-exported workflow exports are not supported');
	}
	if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
		throwUnsupportedWorkflowExports(filePath, 'namespace and export-star workflow exports are not supported');
	}
	const namedExports = statement.exportClause;
	if (namedExports.elements.some((element) => element.isTypeOnly)) {
		throwUnsupportedWorkflowExports(filePath, 'type-only exports are not supported');
	}
	const names = namedExports.elements.map((element) => element.name.text);
	if (names.includes('run')) {
		throwUnsupportedWorkflowRun(filePath, 'export lists for "run" are not supported');
	}
	if (names.includes('channels')) {
		throwUnsupportedWorkflowChannels(filePath, 'export lists for "channels" are not supported');
	}
	throwUnsupportedWorkflowExports(filePath, `unsupported export list for "${names.join(', ')}"`);
}

function declarationName(statement: ts.Statement): string | undefined {
	if (ts.isClassDeclaration(statement)) return statement.name?.text;
	return undefined;
}

function throwUnsupportedWorkflowExports(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported workflow exports in ${filePath}: ${reason}. ` +
			'Workflow modules must directly export "export async function run(...)"; may export "export const channels = [http(), websocket()]"; and must not export anything else.',
	);
}

function throwUnsupportedWorkflowRun(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported workflow run export in ${filePath}: ${reason}. ` +
			'Use a direct exported async function declaration: export async function run(...).',
	);
}

function throwUnsupportedWorkflowChannels(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported workflow channels export in ${filePath}: ${reason}. ` +
			'Use the direct canonical form: export const channels = [http(), websocket()]. Workflows without channels are internal-only.',
	);
}

function parseAgentChannelsInitializer(
	filePath: string,
	initializer: ts.Expression,
): NonNullable<ParsedAgentFile['channels']> {
	const expr = unwrapExpression(initializer);
	if (!ts.isArrayLiteralExpression(expr)) {
		throwUnsupportedAgentChannels(filePath, 'expected a static channel array');
	}

	const result: NonNullable<ParsedAgentFile['channels']> = {};
	for (const element of expr.elements) {
		if (ts.isOmittedExpression(element)) {
			throwUnsupportedAgentChannels(filePath, 'omitted array entries are not supported');
		}
		const channel = parseAgentChannelEntry(filePath, element);
		result[channel] = true;
	}
	return result;
}

function parseAgentChannelEntry(filePath: string, element: ts.Expression): string {
	const expr = unwrapExpression(element);
	if (ts.isIdentifier(expr)) return expr.text;
	if (ts.isCallExpression(expr)) {
		if (expr.arguments.length > 0) {
			throwUnsupportedAgentChannels(filePath, 'channel factory calls must not receive arguments');
		}
		if (!ts.isIdentifier(expr.expression)) {
			throwUnsupportedAgentChannels(filePath, 'channel factories must be direct identifier calls');
		}
		return expr.expression.text;
	}
	throwUnsupportedAgentChannels(filePath, 'channel entries must be direct identifiers or zero-argument calls');
}

function throwUnsupportedAgentExportDeclaration(
	filePath: string,
	statement: ts.ExportDeclaration,
): never {
	if (statement.isTypeOnly) {
		throwUnsupportedAgentExports(filePath, 'type-only exports are not supported');
	}
	if (statement.moduleSpecifier) {
		throwUnsupportedAgentExports(filePath, 're-exported agent exports are not supported');
	}
	if (!statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
		throwUnsupportedAgentExports(filePath, 'namespace and export-star agent exports are not supported');
	}
	const names = statement.exportClause.elements.map((element) => element.name.text);
	throwUnsupportedAgentExports(filePath, `export lists are not supported for "${names.join(', ')}"`);
}

function throwUnsupportedAgentExports(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported agent exports in ${filePath}: ${reason}. ` +
			'Agent modules with external channels must directly export "export const channels = [...]", "export async function receive(...)" and "export async function init(...)"; default exports and triggers are not supported.',
	);
}

function throwUnsupportedAgentChannels(filePath: string, reason: string): never {
	throw new Error(
		`[flue] Unsupported agent channels export in ${filePath}: ${reason}. ` +
			'Use the direct canonical form: export const channels = [discord, gchat] or export const channels = [discord(), gchat()]. Agents without channels are not included in the external-channel build.',
	);
}

function scriptKindForFile(filePath: string): ts.ScriptKind {
	if (/\.m?js$/.test(filePath)) return ts.ScriptKind.JS;
	return ts.ScriptKind.TS;
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
	 * (agents) are discovered from one of two locations inside the root,
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
	const workflows = discoverWorkflows(sourceRoot);
	const appEntry = discoverAppEntry(sourceRoot);

	if (agents.length === 0 && workflows.length === 0) {
		throw new Error(
			`[flue] No agent or workflow files found.\n\n` +
				`Expected at: ${path.join(sourceRoot, 'agents')}/ or ${path.join(sourceRoot, 'workflows')}/\n` +
				`Add at least one agent or workflow file.`,
		);
	}

	if (appEntry) {
		console.log(`[flue] Custom app entry: ${path.relative(root, appEntry) || appEntry}`);
	}

	if (agents.length > 0) {
		console.log(
			`[flue] Found ${agents.length} external-channel agent(s): ${agents.map((a) => a.name).join(', ')}`,
		);
	}
	if (workflows.length > 0) {
		console.log(
			`[flue] Found ${workflows.length} workflow(s): ${workflows.map((workflow) => workflow.name).join(', ')}`,
		);
	}
	console.log(
		`[flue] AGENTS.md and .agents/skills/ will be discovered at runtime from session cwd`,
	);

	fs.mkdirSync(output, { recursive: true });

	const manifest = {
		agents: agents.map((a) => ({
			name: a.name,
			channels: a.channels,
			receive: a.hasReceive,
			init: a.hasInit,
		})),
		workflows: workflows.map((workflow) => ({
			name: workflow.name,
			channels: workflow.channels,
		})),
	};
	const manifestPath = path.join(output, 'manifest.json');
	fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
	console.log(`[flue] Generated: ${manifestPath}`);

	const ctx: BuildContext = {
		agents,
		workflows,
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
		.flatMap((f) => {
			const filePath = path.join(agentsDir, f);
			const parsed = parseAgentFile(filePath);
			if (!parsed.channels) return [];
			return [{
				name: f.replace(/\.(ts|js|mts|mjs)$/, ''),
				filePath,
				channels: parsed.channels,
				hasReceive: parsed.hasReceive,
				hasInit: parsed.hasInit,
			}];
		});
}

function discoverWorkflows(sourceRoot: string): WorkflowInfo[] {
	const workflowsDir = path.join(sourceRoot, 'workflows');
	if (!fs.existsSync(workflowsDir)) return [];

	const files = fs
		.readdirSync(workflowsDir)
		.filter((file) => !/\.d\.(ts|mts)$/.test(file) && /\.(ts|js|mts|mjs)$/.test(file));
	const workflowFiles = new Map<string, string>();
	for (const file of files) {
		const name = file.replace(/\.(ts|js|mts|mjs)$/, '');
		if (!name || name.includes(':')) {
			throw new Error(
				`[flue] Workflow basename "${name}" is invalid. Workflow names must be non-empty and must not contain ":".`,
			);
		}
		const previous = workflowFiles.get(name);
		if (previous) {
			throw new Error(
				`[flue] Duplicate workflow basename "${name}" found: ${previous}, ${file}. Keep only one workflow source file per basename.`,
			);
		}
		workflowFiles.set(name, file);
	}

	return files.map((file) => {
		const filePath = path.join(workflowsDir, file);
		const { channels } = parseWorkflowFile(filePath);
		return {
			name: file.replace(/\.(ts|js|mts|mjs)$/, ''),
			filePath,
			channels,
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
 * `agents/` subdir.
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
