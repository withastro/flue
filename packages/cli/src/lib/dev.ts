/**
 * Flue dev server.
 *
 * Watches the project root, rebuilds on file changes, and reloads the
 * underlying server. Distinct from `flue run`: dev is the long-running,
 * edit-and-iterate command, while `flue run` is the one-shot
 * production-style invoker (build → run → exit).
 *
 * # Watching
 *
 * Watching uses each target's Vite server. Changes are debounced by 150ms.
 * The Node path treats every non-ignored change as a rebuild trigger; the
 * Cloudflare path filters to structural changes only.
 */
import * as fs from 'node:fs';
import { createServer } from 'node:net';
import * as path from 'node:path';
import createDebug from 'debug';
import { build, discoverAgents, discoverChannels, discoverWorkflows } from './build.ts';
import pc from 'picocolors';
import { createEnvLoader, type EnvLoader, selectEnvFile } from './env.ts';
import { type LocalHttpRuntime, startCloudflareLocalRuntime } from './local-http-runtime.ts';
import { createNodeLocalRuntime, type NodeLocalRuntime } from './node-local-runtime.ts';
import { devLog, devServerBanner, error, note } from './terminal.ts';
import type { BuildOptions } from './types.ts';

const debugDev = createDebug('flue:dev');
const debugWatch = createDebug('flue:dev:watch');
const debugServer = createDebug('flue:dev:server');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DevOptions {
	root: string;
	sourceRoot: string;
	version: string;
	/**
	 * Where the build artifacts are written. Defaults to `<root>/dist`.
	 * See {@link BuildOptions.output} for details.
	 */
	output?: string;
	target: 'node' | 'cloudflare';
	/** Defaults to 3583 ("FLUE" on a phone keypad). */
	port?: number;
	strictPort?: boolean;
	envFile?: string;
	envLoader?: EnvLoader;
	configFiles?: readonly string[];
	configFile?: string;
	viteConfig?: import('vite').UserConfig;
	onReady?: () => void;
}

/** Default port for `flue dev`. F=3, L=5, U=8, E=3 on a phone keypad. */
export const DEFAULT_DEV_PORT = 3583;

/**
 * The dev server delegates "what to do with a built artifact" to a
 * target-specific reloader. The reloaders also signal whether a given file
 * change requires action (Node: always; Cloudflare: only structural changes).
 */
interface DevReloader {
	/** Bring the server up for the first time. Throws on failure. */
	start(): Promise<void>;
	/**
	 * Decide whether a root file change should trigger a rebuild.
	 * `relPath` is root-relative.
	 */
	shouldRebuildOn(relPath: string): boolean;
	/**
	 * Run after a rebuild. `buildChanged` is true if the build wrote any new
	 * content to dist/. The reloader may use this to skip an unnecessary
	 * worker restart when nothing changed (Cloudflare body edits).
	 */
	reload(buildChanged: boolean): Promise<void>;
	/** Tear the server down. Idempotent. */
	stop(): Promise<void>;
	/**
	 * Synchronous best-effort cleanup. Called from `process.on('exit')` as a
	 * safety net so we don't leak child processes if the parent exits without
	 * going through `stop()`. Must not throw, must not block.
	 */
	killSync?(): void;
	/** Human-readable URL to print in logs. May be undefined before `start()`. */
	readonly url?: string;
}

// ─── Public entry point ─────────────────────────────────────────────────────

/**
 * Start a Flue dev server. Resolves only when the server is shut down (e.g.
 * via SIGINT). Errors during the initial build/start are thrown synchronously;
 * errors during subsequent rebuilds are logged but do NOT exit the dev server
 * — the user is editing code, after all, and we want to recover when they fix it.
 */
export async function dev(options: DevOptions): Promise<void> {
	const startedAt = Date.now();
	const root = path.resolve(options.root);
	const sourceRoot = path.resolve(options.sourceRoot);
	const output = path.resolve(options.output ?? path.join(root, 'dist'));
	const requestedPort = options.port ?? DEFAULT_DEV_PORT;
	const port =
		options.target === 'node' && options.strictPort !== true
			? await selectAvailableDevPort(requestedPort)
			: requestedPort;
	debugDev(
		'starting target=%s root=%s source=%s output=%s port=%d',
		options.target,
		root,
		sourceRoot,
		output,
		port,
	);

	const envFile = options.envLoader?.file ?? selectEnvFile(options.envFile, root);
	const envLoader = options.envLoader ?? createEnvLoader(envFile);
	if (!options.envLoader) envLoader.apply();

	const buildOptions: BuildOptions = {
		root,
		sourceRoot,
		output,
		target: options.target,
		mode: options.target === 'cloudflare' ? 'development' : 'build',
		log: 'silent',
		configFile: options.configFile,
		envFile: fs.existsSync(envFile) ? envFile : undefined,
	};

	if (options.target === 'cloudflare') {
		try {
			await envLoader.withApplied(() => build(buildOptions));
		} catch (err) {
			throw new Error(`Initial build failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		envLoader.restore();
	}
	let reloader!: DevReloader;
	let rebuilder!: Rebuilder;
	const configFiles = new Set((options.configFiles ?? []).map((file) => path.resolve(file)));
	const onProjectChange = (filePath: string) => {
		const absolutePath = path.resolve(filePath);
		if (absolutePath === envFile || configFiles.has(absolutePath)) return;
		const outputRelative = path.relative(output, absolutePath).replace(/\\/g, '/');
		if (!outputRelative.startsWith('../') && !path.isAbsolute(outputRelative)) return;
		const relPath = path.relative(root, absolutePath).replace(/\\/g, '/');
		if (!relPath || relPath.startsWith('../') || path.isAbsolute(relPath)) return;
		if (!reloader.shouldRebuildOn(relPath)) return;
		devLog(`${pc.dim('changed')} ${relPath}`);
		rebuilder.schedule();
	};
	reloader =
		options.target === 'node'
			? new NodeReloader({
					root,
					sourceRoot,
					port,
					viteConfig: options.viteConfig,
					onProjectChange,
				})
			: new CloudflareReloader({
					root,
					sourceRoot,
					port,
					viteConfig: options.viteConfig,
					onProjectChange,
				});
	const rebuild =
		options.target === 'cloudflare'
			? () => envLoader.withApplied(() => build(buildOptions))
			: async () => ({ changed: true });
	rebuilder = createRebuilder(reloader, rebuild);

	await reloader.start();
	debugDev(
		'ready target=%s url=%s duration=%dms',
		options.target,
		reloader.url,
		Date.now() - startedAt,
	);

	if (reloader.url) {
		devServerBanner(
			options.version,
			Date.now() - startedAt,
			reloader.url,
			discoverAgents(sourceRoot).map((agent) => agent.name),
			discoverWorkflows(sourceRoot).map((workflow) => workflow.name),
			discoverChannels(sourceRoot).map((channel) => channel.name),
		);
	}
	devLog(pc.dim('watching for file changes...'));
	options.onReady?.();

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	let shuttingDown = false;
	const shutdown = async (_signal: string, exitCode: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		try {
			await reloader.stop();
		} catch (err) {
			error(`Shutdown failed: ${err instanceof Error ? err.message : String(err)}`);
		}
		process.exit(exitCode);
	};

	process.on('SIGINT', () => void shutdown('SIGINT', 130));
	process.on('SIGTERM', () => void shutdown('SIGTERM', 143));

	// Last-resort safety net: if the parent exits for any reason (uncaught
	// exception, hard kill from a wrapping process manager, etc.), make a
	// best-effort synchronous attempt to kill any child process the reloader
	// is holding. `process.on('exit')` handlers can't await, so this is sync.
	process.on('exit', () => {
		try {
			reloader.killSync?.();
		} catch {
			/* ignore */
		}
	});

	// Block forever until a signal handler exits the process.
	await new Promise<void>(() => {});
}

// ─── Rebuilder ──────────────────────────────────────────────────────────────

interface Rebuilder {
	/**
	 * Schedule a rebuild. If a rebuild is already running, queues exactly one
	 * follow-up. Multiple calls during the in-flight or queued window are
	 * coalesced.
	 *
	 * `forceReload`: if any scheduled call within a debounce window passes
	 * `true`, the resulting reload is treated as forced — the reloader is
	 * told `buildChanged: true` even if the build wrote nothing new. This keeps
	 * selected env-file changes able to refresh Node runtime behavior even if
	 * generated output is otherwise unchanged.
	 */
	schedule(forceReload?: boolean): void;
}

function createRebuilder(
	reloader: DevReloader,
	rebuild: () => Promise<{ changed: boolean }>,
): Rebuilder {
	let running = false;
	let queued = false;
	let queuedForce = false;
	let pendingForce = false;
	let debounceTimer: NodeJS.Timeout | null = null;

	const runOnce = async (force: boolean) => {
		running = true;
		const start = Date.now();
		debugWatch('rebuild started force=%s', force);
		try {
			const { changed } = await rebuild();
			debugWatch('build completed changed=%s force=%s', changed, force);
			await reloader.reload(changed || force);
			const duration = Date.now() - start;
			debugWatch('rebuild completed duration=%dms', duration);
			devLog(`${pc.dim('reloaded in')} ${duration}ms`);
		} catch (err) {
			// Don't exit the dev loop on a rebuild error — the user is editing
			// code, they'll fix it and trigger another rebuild.
			error(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`);
			note('fix the error; dev is still watching');
			console.error('');
		} finally {
			running = false;
			if (queued) {
				const nextForce = queuedForce;
				debugWatch('running queued rebuild force=%s', nextForce);
				queued = false;
				queuedForce = false;
				void runOnce(nextForce);
			}
		}
	};

	return {
		schedule(forceReload = false) {
			debugWatch('rebuild scheduled force=%s running=%s queued=%s', forceReload, running, queued);
			if (forceReload) pendingForce = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				const force = pendingForce;
				pendingForce = false;
				if (running) {
					debugWatch('rebuild queued force=%s', force);
					queued = true;
					if (force) queuedForce = true;
				} else {
					void runOnce(force);
				}
			}, 150);
		},
	};
}

// ─── Node reloader ──────────────────────────────────────────────────────────

class NodeReloader implements DevReloader {
	private runtime: NodeLocalRuntime | null = null;
	private readonly root: string;
	private readonly sourceRoot: string;
	private readonly port: number;
	private readonly viteConfig: import('vite').UserConfig | undefined;
	private readonly onProjectChange: (filePath: string) => void;
	url: string;

	constructor(opts: {
		root: string;
		sourceRoot: string;
		port: number;
		viteConfig?: import('vite').UserConfig;
		onProjectChange: (filePath: string) => void;
	}) {
		this.root = opts.root;
		this.sourceRoot = opts.sourceRoot;
		this.port = opts.port;
		this.viteConfig = opts.viteConfig;
		this.onProjectChange = opts.onProjectChange;
		this.url = `http://localhost:${this.port}`;
	}

	async start(): Promise<void> {
		debugServer('starting node module runtime port=%d', this.port);
		// Back the dev conversation store with an on-disk SQLite file so history
		// survives HMR reloads within a session. Reset it on each cold start so a
		// fresh `flue dev` begins empty (WAL mode adds the -wal/-shm sidecars).
		const devDbPath = path.join(this.root, 'node_modules', '.cache', 'flue', 'dev.db');
		for (const suffix of ['', '-wal', '-shm']) fs.rmSync(devDbPath + suffix, { force: true });
		this.runtime = await createNodeLocalRuntime({
			root: this.root,
			sourceRoot: this.sourceRoot,
			port: this.port,
			// `flue dev` mirrors production routing (only resources that export a
			// `route` are served), but enables CORS so a separate-origin SPA can
			// call the dev server during local development.
			temporaryLocalExposure: false,
			cors: true,
			env: { ...process.env, FLUE_DEV_SQLITE_PATH: devDbPath },
			internalDevLogs: true,
			viteConfig: this.viteConfig,
			onWatchChange: this.onProjectChange,
			onOutput: ({ line }) => this.renderLine(line),
		});
		await this.runtime.start();
		debugServer('node server ready port=%d', this.port);
	}

	shouldRebuildOn(_relPath: string): boolean {
		return true;
	}

	async reload(_buildChanged: boolean): Promise<void> {
		await this.runtime?.reload();
	}

	async stop(): Promise<void> {
		await this.runtime?.stop();
		this.runtime = null;
	}

	killSync(): void {
		this.runtime?.closeSync();
	}

	// ── Internals ──

	private renderLine(line: string): void {
		if (!line.trim()) return;
		if (
			line.includes('[flue] Server listening') ||
			line.includes('[flue] Agents:') ||
			line.includes('[flue] Mode: local')
		) {
			return;
		}
		if (
			line.includes(
				'ExperimentalWarning: SQLite is an experimental feature and might change at any time',
			)
		)
			return;
		if (line.trim() === '(Use `node --trace-warnings ...` to show where the warning was created)')
			return;
		const lifecycle = line.match(/^(\[(?:agent|workflow)\]\s+)(\S+@\S+)(.*)$/);
		devLog(lifecycle ? `${lifecycle[1]}${pc.blue(lifecycle[2] ?? '')}${lifecycle[3]}` : line);
	}
}

// ─── Cloudflare reloader ────────────────────────────────────────────────────

class CloudflareReloader implements DevReloader {
	private runtime: LocalHttpRuntime | null = null;
	private readonly root: string;
	private readonly sourceRoot: string;
	private readonly port: number;
	private readonly viteConfig: import('vite').UserConfig | undefined;
	private readonly onProjectChange: (filePath: string) => void;
	url?: string;

	constructor(opts: {
		root: string;
		sourceRoot: string;
		port: number;
		viteConfig?: import('vite').UserConfig;
		onProjectChange: (filePath: string) => void;
	}) {
		this.root = opts.root;
		this.sourceRoot = opts.sourceRoot;
		this.port = opts.port;
		this.viteConfig = opts.viteConfig;
		this.onProjectChange = opts.onProjectChange;
	}

	async start(): Promise<void> {
		const started = await startCloudflareLocalRuntime({
			root: this.root,
			port: this.port,
			watch: true,
			viteConfig: this.viteConfig,
			onWatchChange: this.onProjectChange,
			cloudflareLogLevel: 'info',
		});
		this.runtime = { target: 'cloudflare', ...started };
		this.url = started.url;
	}

	shouldRebuildOn(relPath: string): boolean {
		const normalized = relPath.replace(/\\/g, '/');
		if (
			normalized === 'wrangler.jsonc' ||
			normalized === 'wrangler.json' ||
			normalized === 'wrangler.toml'
		)
			return true;
		return isSourceStructurePath(this.root, this.sourceRoot, normalized);
	}

	async reload(buildChanged: boolean): Promise<void> {
		if (buildChanged) await this.runtime?.reload();
	}

	async stop(): Promise<void> {
		await this.runtime?.stop();
		this.runtime = null;
	}

	killSync(): void {
		this.runtime?.killSync();
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

async function selectAvailableDevPort(start: number): Promise<number> {
	for (let port = start; port <= 65_535; port += 1) {
		if (await canListen(port)) return port;
	}
	throw new Error(`No available port found at or above ${start}.`);
}

async function canListen(port: number): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		const server = createServer();
		server.once('error', () => resolve(false));
		server.listen(port, () => server.close(() => resolve(true)));
	});
}

function isSourceStructurePath(root: string, sourceRoot: string, relPath: string): boolean {
	const prefix = path.relative(root, sourceRoot).replace(/\\/g, '/');
	const sourceRelative = prefix
		? relPath.startsWith(`${prefix}/`)
			? relPath.slice(prefix.length + 1)
			: null
		: relPath;
	if (sourceRelative === null) return false;
	if (
		sourceRelative.startsWith('agents/') ||
		sourceRelative.startsWith('workflows/') ||
		sourceRelative.startsWith('channels/')
	)
		return true;
	return /^(?:app|cloudflare)\.(?:ts|mts|js|mjs)$/.test(sourceRelative);
}
