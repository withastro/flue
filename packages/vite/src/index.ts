import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import { builtinModules } from 'node:module';
import * as path from 'node:path';
import { cloudflare } from '@cloudflare/vite-plugin';
import {
	build,
	cloudflareViteConfigPath,
	cloudflareViteInputDir,
	createEnvLoader,
	createSharedViteConfig,
	discoverAgents,
	discoverAppEntry,
	discoverWorkflows,
	getUserExternals,
	readRuntimeVersion,
	resolvePlugin,
	selectEnvFile,
	viteGeneratedEntryDependencyResolver,
} from '@flue/cli/internal/vite';
import { resolveConfig, resolveConfigPath } from '@flue/cli/config';
import type { FlueConfig } from '@flue/cli/config';
import type { PluginOption, UserConfig } from 'vite';

export interface FlueViteOptions {
	cwd?: string;
}

export async function flue(options: FlueViteOptions = {}): Promise<PluginOption[]> {
	const cwd = path.resolve(options.cwd ?? process.cwd());
	const configPath = resolveConfigPath({ cwd });
	const envLoader = createEnvLoader(selectEnvFile(undefined, configPath ? path.dirname(configPath) : cwd));
	envLoader.apply();
	const { flueConfig } = await resolveConfig({ cwd });
	return flueConfig.target === 'node' ? createNodePlugins(flueConfig) : createCloudflarePlugins(flueConfig);
}

async function createNodePlugins(flueConfig: FlueConfig): Promise<PluginOption[]> {
	const root = flueConfig.root;
	const plan = await createPlan(flueConfig);
	const entryPath = path.join(cloudflareViteInputDir(root), '_entry_server.ts');
	writeIfChanged(entryPath, plan.entrySource);
	const sharedConfig = createSharedViteConfig(root, [entryPath]);
	let command: 'build' | 'serve' | undefined;
	let supervisor: NodeSupervisor | undefined;
	return [
		...sharedConfig.plugins,
		viteGeneratedEntryDependencyResolver(root),
		{
			name: 'flue-node',
			config(_config, env): UserConfig {
				command = env.command;
				return {
					root,
					appType: 'custom',
					build: createNodeBuildConfig(flueConfig, entryPath, plan.plugin.external),
				};
			},
			async configureServer(server) {
				if (command !== 'serve') return;
				supervisor = await NodeSupervisor.create({ flueConfig, local: true });
				await supervisor.start();
				server.config.server.proxy = createProxy(supervisor.port);
				server.watcher.on('change', async (file) => {
					if (!isWithinRoot(file, root)) return;
					await supervisor?.rebuild();
				});
				server.httpServer?.once('close', () => void supervisor?.stop());
			},
			async configurePreviewServer(server) {
				supervisor = await NodeSupervisor.create({ flueConfig, local: false });
				await supervisor.start();
				server.config.preview.proxy = createProxy(supervisor.port);
				server.httpServer.once('close', () => void supervisor?.stop());
			},
		},
	];
}

async function createCloudflarePlugins(flueConfig: FlueConfig): Promise<PluginOption[]> {
	const root = flueConfig.root;
	const inputDir = cloudflareViteInputDir(root);
	const entryPath = path.join(inputDir, '_entry.ts');
	const configPath = cloudflareViteConfigPath(root);
	let restarting = false;
	return [
		{
			name: 'flue-cloudflare',
			enforce: 'pre',
			async config(_config, env): Promise<UserConfig> {
				if (!env.isPreview) await writeCloudflareInputs(flueConfig);
				return { root, build: { outDir: flueConfig.output, emptyOutDir: true } };
			},
			configureServer(server) {
				server.watcher.on('all', async (event, file) => {
					if (restarting || !shouldRefreshCloudflareInputs(flueConfig, event, file)) return;
					restarting = true;
					try {
						if (await writeCloudflareInputs(flueConfig)) await server.restart();
					} finally {
						restarting = false;
					}
				});
			},
		},
		...createSharedViteConfig(root, [entryPath]).plugins,
		...cloudflare({
			configPath,
			persistState: true,
			inspectorPort: false,
		}),
	];
}

async function writeCloudflareInputs(flueConfig: FlueConfig): Promise<boolean> {
	const plan = await createPlan(flueConfig);
	const inputDir = cloudflareViteInputDir(flueConfig.root);
	let changed = writeIfChanged(path.join(inputDir, plan.plugin.entryFilename ?? '_entry.ts'), plan.entrySource);
	if (!plan.plugin.additionalOutputs) {
		throw new Error('[flue] Cloudflare target did not provide generated Wrangler configuration.');
	}
	for (const [filename, content] of Object.entries(await plan.plugin.additionalOutputs(plan.ctx))) {
		changed =
			writeIfChanged(
				filename === 'wrangler.jsonc'
					? cloudflareViteConfigPath(flueConfig.root)
					: path.join(inputDir, filename),
				content,
			) || changed;
	}
	return changed;
}

function createNodeBuildConfig(
	flueConfig: FlueConfig,
	entryPath: string,
	pluginExternal: string[] | undefined,
): NonNullable<UserConfig['build']> {
	return {
		ssr: entryPath,
		outDir: flueConfig.output,
		emptyOutDir: true,
		sourcemap: true,
		target: 'node22',
		rolldownOptions: {
			external: [
				...(pluginExternal ?? []),
				...getUserExternals(flueConfig.root),
				...builtinModules,
				...builtinModules.map((name) => `node:${name}`),
			],
			output: { entryFileNames: 'server.mjs', format: 'es' },
		},
	};
}

async function createPlan(flueConfig: FlueConfig) {
	const agents = discoverAgents(flueConfig.sourceRoot);
	const workflows = discoverWorkflows(flueConfig.sourceRoot);
	if (agents.length === 0 && workflows.length === 0) {
		throw new Error(
			`[flue] No agent or workflow files found.\n\nExpected at: ${path.join(flueConfig.sourceRoot, 'agents')}/ or ${path.join(flueConfig.sourceRoot, 'workflows')}/\nAdd at least one agent or workflow file.`,
		);
	}
	const plugin = resolvePlugin({ ...flueConfig });
	const ctx = {
		agents,
		workflows,
		root: flueConfig.root,
		output: flueConfig.output,
		appEntry: discoverAppEntry(flueConfig.sourceRoot),
		runtimeVersion: readRuntimeVersion(flueConfig.root),
		options: { ...flueConfig },
	};
	return { ctx, entrySource: await plugin.generateEntryPoint(ctx), plugin };
}

class NodeSupervisor {
	private child: ChildProcess | undefined;
	private rebuilding = Promise.resolve();
	readonly port: number;

	private constructor(
		private readonly flueConfig: FlueConfig,
		private readonly local: boolean,
		port: number,
	) {
		this.port = port;
	}

	static async create(options: { flueConfig: FlueConfig; local: boolean }): Promise<NodeSupervisor> {
		return new NodeSupervisor(options.flueConfig, options.local, await findAvailablePort());
	}

	async start(): Promise<void> {
		if (this.local) await this.build();
		await this.spawn();
	}

	rebuild(): Promise<void> {
		this.rebuilding = this.rebuilding.then(async () => {
			await this.build();
			await this.stop();
			await this.spawn();
		});
		return this.rebuilding;
	}

	async stop(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		if (!child || child.killed) return;
		await new Promise<void>((resolve) => {
			const done = () => resolve();
			child.once('exit', done);
			child.kill('SIGTERM');
			setTimeout(() => {
				if (!child.killed) child.kill('SIGKILL');
				done();
			}, 1_000);
		});
	}

	private async build(): Promise<void> {
		await build({ ...this.flueConfig, mode: 'build' });
	}

	private async spawn(): Promise<void> {
		const serverPath = path.join(this.flueConfig.output, 'server.mjs');
		if (!fs.existsSync(serverPath)) {
			throw new Error(`[flue] Node preview requires an existing build artifact: ${serverPath}`);
		}
		const child = spawn('node', [serverPath], {
			cwd: this.flueConfig.root,
			stdio: ['ignore', 'pipe', 'pipe'],
			env: { ...process.env, PORT: String(this.port), ...(this.local ? { FLUE_MODE: 'local' } : {}) },
		});
		this.child = child;
		child.stdout?.pipe(process.stdout);
		child.stderr?.pipe(process.stderr);
		child.once('exit', () => {
			if (this.child === child) this.child = undefined;
		});
	}
}

function createProxy(port: number) {
	return { '^/': { target: `http://127.0.0.1:${port}`, ws: true } };
}

function findAvailablePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			if (!address || typeof address === 'string') {
				server.close();
				reject(new Error('[flue] Could not allocate an internal Node server port.'));
				return;
			}
			server.close(() => resolve(address.port));
		});
	});
}

function isWithinRoot(filePath: string, root: string): boolean {
	const relative = path.relative(root, filePath);
	return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function shouldRefreshCloudflareInputs(
	flueConfig: FlueConfig,
	event: string,
	filePath: string,
): boolean {
	if (!isWithinRoot(filePath, flueConfig.root)) return false;
	const relative = path.relative(flueConfig.root, filePath).replace(/\\/g, '/');
	if (relative === 'wrangler.jsonc' || relative === 'wrangler.json' || relative === 'wrangler.toml') {
		return true;
	}
	if (event !== 'add' && event !== 'unlink') return false;
	const sourceRelative = path.relative(flueConfig.sourceRoot, filePath).replace(/\\/g, '/');
	return (
		(!sourceRelative.startsWith('../') &&
			(sourceRelative.startsWith('agents/') || sourceRelative.startsWith('workflows/'))) ||
		/^app\.(?:ts|mts|js|mjs)$/.test(sourceRelative)
	);
}

function writeIfChanged(filePath: string, content: string): boolean {
	if (fs.existsSync(filePath) && fs.readFileSync(filePath, 'utf-8') === content) return false;
	fs.mkdirSync(path.dirname(filePath), { recursive: true });
	fs.writeFileSync(filePath, content, 'utf-8');
	return true;
}
