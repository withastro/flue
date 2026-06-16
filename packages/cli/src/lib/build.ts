import * as fs from 'node:fs';
import { builtinModules, createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cloudflare } from '@cloudflare/vite-plugin';
import { packageUpSync } from 'package-up';
import { CloudflarePlugin } from './build-plugin-cloudflare.ts';
import { NodePlugin } from './build-plugin-node.ts';
import { brandRows, section, success } from './terminal.ts';
import type {
	AgentInfo,
	BuildContext,
	BuildOptions,
	BuildPlugin,
	ChannelInfo,
	WorkflowInfo,
} from './types.ts';
import { importAttributePlugin } from './vite-import-attribute-plugin.ts';

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
 * `options.root` is the project root — typically the user's cwd.
 *
 * Build output lands in `options.output` (defaults to `<root>/dist`).
 *
 * AGENTS.md and workspace .agents/skills/ are discovered at runtime from session cwd.
 * Statically imported SKILL.md directories are packaged through the shared Vite graph.
 */
export async function build(options: BuildOptions): Promise<BuildResult> {
	if (options.target !== 'cloudflare') return buildApplication(options);
	const root = path.resolve(options.root);
	const { loadEnv } = await import('vite');
	const mode = options.mode === 'development' ? 'development' : 'production';
	const env = loadEnv(mode, root, ['CLOUDFLARE_', 'WRANGLER_HYPERDRIVE_LOCAL_CONNECTION_STRING_']);
	return withTemporaryProcessEnv(env, () => buildApplication(options));
}

async function buildApplication(options: BuildOptions): Promise<BuildResult> {
	const root = path.resolve(options.root);
	const output = path.resolve(options.output ?? path.join(root, 'dist'));
	const plugin: BuildPlugin = resolvePlugin(options);
	const verbose = options.log !== 'silent';
	const rel = (filePath: string) => {
		const relative = path.relative(root, filePath);
		return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
			? relative
			: filePath;
	};

	const sourceRoot = path.resolve(options.sourceRoot);

	const agents = discoverAgents(sourceRoot);
	const workflows = discoverWorkflows(sourceRoot);
	const channels = discoverChannels(sourceRoot);
	const appEntry = discoverOptionalEntry(sourceRoot, 'app');
	const cloudflareEntry = discoverOptionalEntry(sourceRoot, 'cloudflare');
	const dbEntry = discoverOptionalEntry(sourceRoot, 'db');

	if (verbose) {
		brandRows('flue build', [
			['target', plugin.name],
			['output', rel(output)],
			['config', options.configFile ? rel(options.configFile) : undefined],
			['env', options.envFile ? rel(options.envFile) : undefined],
			['source', rel(sourceRoot)],
			['app', appEntry ? rel(appEntry) : undefined],
			['database', dbEntry ? rel(dbEntry) : undefined],
			[
				'cloudflare',
				cloudflareEntry && plugin.name === 'cloudflare' ? rel(cloudflareEntry) : undefined,
			],
		]);
		section(
			'agents',
			agents.map((agent) => agent.name),
		);
		section(
			'workflows',
			workflows.map((workflow) => workflow.name),
		);
		section(
			'channels',
			channels.map((channel) => channel.name),
		);
		console.error('');
	}

	if (agents.length === 0 && workflows.length === 0) {
		throw new Error(
			`[flue] No agent or workflow files found.\n\n` +
				`Expected at: ${path.join(sourceRoot, 'agents')}/ or ${path.join(sourceRoot, 'workflows')}/\n` +
				`Add at least one agent or workflow file.`,
		);
	}

	fs.mkdirSync(output, { recursive: true });

	let anyChanged = false;

	const ctx: BuildContext = {
		agents,
		workflows,
		channels,
		root,
		output,
		appEntry,
		cloudflareEntry,
		dbEntry,
		runtimeVersion: readRuntimeVersion(root),
	};

	const serverCode = await plugin.generateEntryPoint(ctx);
	const bundleStrategy = plugin.bundle;

	if (bundleStrategy === 'vite') {
		// Write the generated entry to the scratch input dir (not the output
		// dir) so the build can empty the output dir, matching the cloudflare
		// target and preventing stale artifacts from earlier builds.
		const inputDir = viteInputDir(root);
		const entryPath = path.join(inputDir, '_entry_server.ts');
		const outPath = path.join(output, 'server.mjs');
		fs.mkdirSync(inputDir, { recursive: true });
		fs.writeFileSync(entryPath, serverCode, 'utf-8');
		try {
			const pluginExternal = plugin.external ?? [];
			const userExternals = getUserExternals(root);
			const { build: viteBuild } = await import('vite');
			const sharedViteConfig = createSharedViteConfig(root, [entryPath]);
			await viteBuild({
				...sharedViteConfig,
				logLevel: 'warn',
				plugins: [...sharedViteConfig.plugins, viteGeneratedEntryDependencyResolver(root)],
				build: {
					ssr: entryPath,
					outDir: output,
					emptyOutDir: true,
					sourcemap: true,
					target: 'node22',
					rolldownOptions: {
						external: [
							...pluginExternal,
							...userExternals,
							...builtinModules,
							...builtinModules.map((name) => `node:${name}`),
						],
						output: { entryFileNames: 'server.mjs', format: 'es' },
					},
				},
			});
			if (verbose) success(`built ${rel(outPath)}`);
			anyChanged = true;
		} finally {
			try {
				fs.unlinkSync(entryPath);
			} catch {
				/* ignore */
			}
		}
	} else if (bundleStrategy === 'vite-cloudflare') {
		if (!plugin.entryFilename || !plugin.viteInputs) {
			throw new Error(
				`[flue] Plugin "${plugin.name}" set bundle: 'vite-cloudflare' but did not provide its generated entry and Vite inputs.`,
			);
		}
		const inputDir = viteInputDir(root);
		const entryPath = path.join(inputDir, plugin.entryFilename);
		const inputs = await plugin.viteInputs(ctx);
		let generatedChanged =
			!fs.existsSync(entryPath) || fs.readFileSync(entryPath, 'utf-8') !== serverCode;
		fs.mkdirSync(inputDir, { recursive: true });
		if (generatedChanged) fs.writeFileSync(entryPath, serverCode, 'utf-8');
		const inputFiles: Array<[string, string]> = [
			[cloudflareViteConfigPath(root), inputs.wranglerConfig],
			...Object.entries(inputs.entryDirFiles ?? {}).map(([filename, content]): [string, string] => [
				path.join(inputDir, filename),
				content,
			]),
		];
		for (const [filePath, content] of inputFiles) {
			const changed = !fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8') !== content;
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			if (changed) fs.writeFileSync(filePath, content, 'utf-8');
			generatedChanged ||= changed;
		}
		if (options.mode === 'development') {
			if (verbose) success(`prepared ${rel(entryPath)}`);
			return { changed: generatedChanged };
		}
		const generatedConfigPath = cloudflareViteConfigPath(root);
		const { createBuilder } = await import('vite');
		const viteConfig = createCloudflareViteConfig(root, generatedConfigPath, [entryPath]);
		await withTemporaryProcessEnv({ NODE_ENV: 'production' }, async () => {
			const builder = await createBuilder({
				...viteConfig,
				mode: 'production',
				logLevel: 'warn',
				build: { outDir: output, emptyOutDir: true },
			});
			await builder.buildApp();
		});
		if (verbose) success(`built ${rel(output)}`);
		anyChanged = true;
	}

	if (plugin.additionalOutputs) {
		const outputs = await plugin.additionalOutputs(ctx);
		for (const [filename, content] of Object.entries(outputs)) {
			const filePath = path.join(output, filename);
			fs.mkdirSync(path.dirname(filePath), { recursive: true });
			// Avoid touching generated files if content is unchanged so development
			// watchers do not see spurious mtime updates and reload for no reason.
			const changed = !fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf-8') !== content;
			if (changed) {
				fs.writeFileSync(filePath, content, 'utf-8');
				if (verbose) success(`generated ${rel(filePath)}`);
				anyChanged = true;
			}
		}
	}

	if (verbose) success(`ready ${rel(output)}`);
	return { changed: anyChanged };
}

async function withTemporaryProcessEnv<T>(
	env: Record<string, string>,
	fn: () => Promise<T>,
): Promise<T> {
	const previous = new Map<string, string | undefined>();
	for (const [key, value] of Object.entries(env)) {
		previous.set(key, process.env[key]);
		process.env[key] = value;
	}
	try {
		return await fn();
	} finally {
		for (const [key, value] of previous) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
	}
}

function resolvePlugin(options: BuildOptions): BuildPlugin {
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

export function discoverAgents(sourceRoot: string): AgentInfo[] {
	return discoverModules(sourceRoot, 'agent');
}

export function discoverWorkflows(sourceRoot: string): WorkflowInfo[] {
	return discoverModules(sourceRoot, 'workflow');
}

export function discoverChannels(sourceRoot: string): ChannelInfo[] {
	return discoverModules(sourceRoot, 'channel');
}

function discoverModules(sourceRoot: string, kind: 'agent' | 'workflow' | 'channel'): AgentInfo[] {
	const modulesDir = path.join(sourceRoot, `${kind}s`);
	if (!fs.existsSync(modulesDir)) return [];

	const files = fs
		.readdirSync(modulesDir)
		.filter((file) => !/\.d\.(ts|mts)$/.test(file) && /\.(ts|js|mts|mjs)$/.test(file));
	const seen = new Map<string, string>();
	const modules: AgentInfo[] = [];
	for (const file of files) {
		const name = file.replace(/\.(ts|js|mts|mjs)$/, '');
		// Agent and channel names ban ':' because their URL addressing reserves
		// a single filename-derived namespace segment.
		if (!name || ((kind === 'agent' || kind === 'channel') && name.includes(':'))) {
			throw new Error(
				kind === 'workflow'
					? `[flue] Workflow basename "${name}" is invalid. Workflow names must be non-empty.`
					: `[flue] ${kind === 'agent' ? 'Agent' : 'Channel'} basename "${name}" is invalid. ${kind === 'agent' ? 'Agent' : 'Channel'} names must be non-empty and must not contain ":".`,
			);
		}
		const previous = seen.get(name);
		if (previous) {
			throw new Error(
				`[flue] Duplicate ${kind} basename "${name}" found: ${previous}, ${file}. Keep only one ${kind} source file per basename.`,
			);
		}
		seen.set(name, file);
		modules.push({ name, filePath: path.join(modulesDir, file) });
	}
	return modules;
}

function discoverOptionalEntry(sourceRoot: string, basename: string): string | undefined {
	for (const ext of ['ts', 'mts', 'js', 'mjs']) {
		const candidate = path.join(sourceRoot, `${basename}.${ext}`);
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
		}).filter((name) => name !== '@flue/runtime');
		return deps.flatMap((name) => [name, `${name}/*`]);
	} catch {
		return [];
	}
}

export function viteInputDir(root: string): string {
	return path.join(root, '.flue-vite');
}

export function cloudflareViteConfigPath(root: string): string {
	return path.join(root, '.flue-vite.wrangler.jsonc');
}

function createSharedViteConfig(root: string, bootstrapEntries: readonly string[] = []) {
	return {
		configFile: false as const,
		root,
		plugins: [importAttributePlugin({ bootstrapEntries })],
	};
}

export function createCloudflareViteConfig(
	root: string,
	configPath: string,
	bootstrapEntries: readonly string[] = [],
	options: { persistState?: boolean } = {},
) {
	const sharedConfig = createSharedViteConfig(root, bootstrapEntries);
	return {
		...sharedConfig,
		plugins: [
			...sharedConfig.plugins,
			...cloudflare({
				configPath,
				persistState: options.persistState ?? true,
				inspectorPort: false,
			}),
		],
	};
}

function viteGeneratedEntryDependencyResolver(root: string) {
	const resolvers = [...collectNodePaths(root)].map((nodePath) =>
		createRequire(path.join(nodePath, '__flue_vite_resolve__.cjs')),
	);
	return {
		name: 'flue-generated-entry-dependency-resolver',
		enforce: 'pre' as const,
		resolveId(source: string) {
			if (
				source.startsWith('.') ||
				source.startsWith('/') ||
				source.startsWith('\0') ||
				source.startsWith('virtual:') ||
				source.startsWith('node:')
			)
				return null;
			for (const resolve of resolvers) {
				try {
					return resolve.resolve(source);
				} catch {}
			}
			return null;
		},
	};
}

function collectNodePaths(root: string): Set<string> {
	const nodePathsSet = new Set<string>();
	// Walk up from the project root (user's deps), the CLI's own location
	// (in case the build needs CLI-bundled helpers), and `@flue/runtime`'s
	// install location as resolved from the project. The latter is what
	// surfaces the runtime deps (`@hono/node-server`, `hono`, `pi-ai`,
	// etc.) that the generated `server.mjs` imports — `@flue/runtime` is the
	// package that lists them, so the Vite build must be able to reach its
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
	return path.dirname(fileURLToPath(import.meta.url));
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
