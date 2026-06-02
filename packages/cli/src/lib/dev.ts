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
 * Watching uses `node:fs.watch` recursive (Node 20+). Debounced 150ms. The
 * Node path treats every non-ignored change as a rebuild trigger; the
 * Cloudflare path filters to "structural" changes only.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	build,
	cloudflareViteConfigPath,
	cloudflareViteInputDir,
	createCloudflareViteConfig,
} from './build.ts';
import { createEnvLoader, type EnvLoader, selectEnvFile } from './env.ts';
import type { BuildOptions } from './types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DevOptions {
	root: string;
	sourceRoot: string;
	/**
	 * Where the build artifacts are written. Defaults to `<root>/dist`.
	 * See {@link BuildOptions.output} for details.
	 */
	output?: string;
	target: 'node' | 'cloudflare';
	/** Defaults to 3583 ("FLUE" on a phone keypad). */
	port?: number;
	envFile?: string;
	envLoader?: EnvLoader;
	configFiles?: readonly string[];
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
	const root = path.resolve(options.root);
	const sourceRoot = path.resolve(options.sourceRoot);
	const output = path.resolve(options.output ?? path.join(root, 'dist'));
	const port = options.port ?? DEFAULT_DEV_PORT;

	const envFile = options.envLoader?.file ?? selectEnvFile(options.envFile, root);
	const envLoader = options.envLoader ?? createEnvLoader(envFile);
	if (!options.envLoader) envLoader.apply();

	const buildOptions: BuildOptions = {
		root,
		sourceRoot,
		output,
		target: options.target,
		mode: options.target === 'cloudflare' ? 'development' : 'build',
	};

	console.error(`[flue] Starting dev server (target: ${options.target})`);
	console.error(`[flue] Watching: ${root}`);
	console.error(`[flue] Building...`);

	const initialStart = Date.now();
	try {
		if (options.target === 'cloudflare') {
			await envLoader.withApplied(() => build(buildOptions));
		} else {
			await build(buildOptions);
		}
	} catch (err) {
		throw new Error(
			`[flue] Initial build failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	console.error(`[flue] Built in ${Date.now() - initialStart}ms`);

	if (options.target === 'cloudflare') envLoader.restore();
	const reloader: DevReloader =
		options.target === 'node'
			? new NodeReloader({ root, output, port })
			: await createCloudflareReloader({ root, sourceRoot, port });

	await reloader.start();

	if (reloader.url) {
		console.error(`[flue] Server: ${reloader.url}`);
		const exampleAgent = pickExampleAgentName(sourceRoot);
		if (exampleAgent) {
			console.error(`[flue] Try: curl -X POST ${reloader.url}/agents/${exampleAgent}/test-1 \\`);
			console.error(`         -H 'Content-Type: application/json' -d '{}'`);
		}
	}
	console.error(`[flue] Press Ctrl+C to stop\n`);
	options.onReady?.();

	// ─── Watch loop ──────────────────────────────────────────────────────────

	const rebuild =
		options.target === 'cloudflare'
			? () => envLoader.withApplied(() => build(buildOptions))
			: () => build(buildOptions);
	const rebuilder = createRebuilder(buildOptions, reloader, rebuild);
	const watcher = createWatcher({
		root,
		sourceRoot,
		output,
		envFile,
		configFiles: options.configFiles ?? [],
		onChange: (relPath) => {
			const isEnvFile = relPath === envFile;
			if (!isEnvFile && !reloader.shouldRebuildOn(relPath)) return;
			if (isEnvFile && options.target === 'node') {
				try {
					envLoader.apply();
				} catch (err) {
					console.error(
						`[flue] Environment reload failed: ${err instanceof Error ? err.message : String(err)}`,
					);
					return;
				}
			}
			console.error(`[flue] Change detected: ${relPath}`);
			rebuilder.schedule(isEnvFile);
		},
	});

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	let shuttingDown = false;
	const shutdown = async (signal: string, exitCode: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.error(`\n[flue] Received ${signal}, shutting down...`);
		watcher.close();
		try {
			await reloader.stop();
		} catch (err) {
			console.error(
				`[flue] Error during shutdown: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
		console.error(`[flue] Stopped.`);
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
	buildOptions: BuildOptions,
	reloader: DevReloader,
	rebuild: () => Promise<{ changed: boolean }> = () => build(buildOptions),
): Rebuilder {
	let running = false;
	let queued = false;
	let queuedForce = false;
	let pendingForce = false;
	let debounceTimer: NodeJS.Timeout | null = null;

	const runOnce = async (force: boolean) => {
		running = true;
		const start = Date.now();
		console.error(`[flue] Rebuilding...`);
		try {
			const { changed } = await rebuild();
			await reloader.reload(changed || force);
			console.error(`[flue] Reloaded in ${Date.now() - start}ms\n`);
		} catch (err) {
			// Don't exit the dev loop on a rebuild error — the user is editing
			// code, they'll fix it and trigger another rebuild.
			console.error(`[flue] Rebuild failed: ${err instanceof Error ? err.message : String(err)}\n`);
		} finally {
			running = false;
			if (queued) {
				const nextForce = queuedForce;
				queued = false;
				queuedForce = false;
				void runOnce(nextForce);
			}
		}
	};

	return {
		schedule(forceReload = false) {
			if (forceReload) pendingForce = true;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = null;
				const force = pendingForce;
				pendingForce = false;
				if (running) {
					queued = true;
					if (force) queuedForce = true;
				} else {
					void runOnce(force);
				}
			}, 150);
		},
	};
}

// ─── Watcher ────────────────────────────────────────────────────────────────

interface WatcherOptions {
	root: string;
	sourceRoot: string;
	/**
	 * Absolute path to the build output directory. Anything inside this
	 * directory is ignored by the watcher — otherwise build writes would
	 * trigger spurious rebuilds (and an infinite loop).
	 */
	output: string;
	/** Absolute path of the selected env file to watch. */
	envFile: string;
	configFiles: readonly string[];
	onChange: (relPath: string) => void;
}

interface WatcherHandle {
	close(): void;
}

/**
 * Watch the root for changes. Uses `fs.watch` recursive (Node 20+).
 *
 * Watched roots:
 *   - `<root>` — authored source and any project-local modules it imports,
 *     plus project configuration files, including Wrangler configuration.
 *
 * Ignored:
 *   - The build output directory (`output`, defaults to `<root>/dist`).
 *     Critical to break the build → file-change → rebuild loop.
 *   - `node_modules/`, `.git/`, `.turbo/`
 *   - Dotfiles and dotdirs at the project root, with one exception: `.flue/`
 *     is allowed through only when it is the selected source directory.
 *   - Editor backup/swap suffixes
 */
function createWatcher(options: WatcherOptions): WatcherHandle {
	const { root, sourceRoot, output, envFile, configFiles, onChange } = options;
	const watchers: fs.FSWatcher[] = [];
	const watchesDotFlue = sourceRoot === path.join(root, '.flue');
	const ignoredConfigFiles = new Set(configFiles.map((file) => path.resolve(file)));

	// Pre-compute the root-relative path of output for fast prefix
	// checks. If output lives outside root, the recursive watcher
	// won't see writes there at all — but we still ignore any path that
	// resolves into it, just to be safe across platforms.
	const outputRelToRoot = path.relative(root, output).split(path.sep).join('/');

	const isIgnoredPath = (relPath: string): boolean => {
		const normalized = relPath.replace(/\\/g, '/');
		if (ignoredConfigFiles.has(path.resolve(root, relPath))) return true;
		if (watchesDotFlue && (normalized === '.flue' || normalized.startsWith('.flue/'))) {
			return false;
		}
		// Anything inside the build output dir — even when the user redirects
		// it via --output to something other than `dist/` — must be ignored,
		// or the build's own writes would trigger an infinite rebuild loop.
		if (
			outputRelToRoot &&
			!outputRelToRoot.startsWith('..') &&
			(normalized === outputRelToRoot || normalized.startsWith(`${outputRelToRoot}/`))
		) {
			return true;
		}
		const parts = normalized.split('/');
		for (const part of parts) {
			if (part === 'node_modules') return true;
			if (part === '.git') return true;
			if (part === '.turbo') return true;
		}
		const base = parts[parts.length - 1] ?? '';
		if (!base) return true;
		if (base.startsWith('.')) return true;
		if (base.endsWith('~') || base.endsWith('.swp') || base.endsWith('.swx')) return true;
		return false;
	};

	try {
		const w = fs.watch(root, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			const rel = filename.toString();
			if (isIgnoredPath(rel)) return;
			onChange(rel);
		});
		watchers.push(w);
	} catch (err) {
		console.error(
			`[flue] Failed to watch ${root}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	try {
		const envDirectory = path.dirname(envFile);
		const envBasename = path.basename(envFile);
		const w = fs.watch(envDirectory, (_event, filename) => {
			if (filename?.toString() === envBasename) onChange(envFile);
		});
		watchers.push(w);
	} catch {}

	return {
		close() {
			for (const w of watchers) {
				try {
					w.close();
				} catch {
					// ignore
				}
			}
		},
	};
}

// ─── Node reloader ──────────────────────────────────────────────────────────

class NodeReloader implements DevReloader {
	private child: ChildProcess | null = null;
	private readonly serverPath: string;
	private readonly root: string;
	private readonly port: number;
	url: string;

	constructor(opts: { root: string; output: string; port: number }) {
		this.root = opts.root;
		this.port = opts.port;
		this.serverPath = path.join(opts.output, 'server.mjs');
		this.url = `http://localhost:${this.port}`;
	}

	async start(): Promise<void> {
		await this.spawnAndWait();
	}

	// Node has no downstream watcher — every root change requires a
	// rebuild + child respawn. The watcher's ignore list already filters
	// dist/, node_modules/, etc.
	shouldRebuildOn(_relPath: string): boolean {
		return true;
	}

	async reload(_buildChanged: boolean): Promise<void> {
		// On Node we always restart the child after a successful rebuild because
		// it has the previous server module graph loaded in memory.
		await this.killChild();
		await this.spawnAndWait();
	}

	async stop(): Promise<void> {
		await this.killChild();
	}

	killSync(): void {
		const child = this.child;
		if (!child || child.killed) return;
		try {
			child.kill('SIGKILL');
		} catch {
			/* ignore */
		}
	}

	// ── Internals ──

	private async spawnAndWait(): Promise<void> {
		const child = spawn('node', [this.serverPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			cwd: this.root,
			env: {
				...process.env,
				PORT: String(this.port),
				FLUE_MODE: 'local',
			},
		});
		this.child = child;

		const pipe = (data: Buffer) => {
			const text = data.toString().trimEnd();
			for (const line of text.split('\n')) {
				if (!line.trim()) continue;
				if (
					line.includes('[flue] Server listening') ||
					line.includes('[flue] Available agents:') ||
					line.includes('[flue] Mode: local')
				) {
					continue;
				}
				console.error(line);
			}
		};
		child.stdout?.on('data', pipe);
		child.stderr?.on('data', pipe);

		child.on('exit', (code, signal) => {
			if (this.child === child) {
				this.child = null;
				if (code !== 0 && code !== null) {
					console.error(
						`[flue] Node server exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`,
					);
				}
			}
		});

		// No readiness probe: user apps own their routes, including health checks.
	}

	private async killChild(): Promise<void> {
		const child = this.child;
		if (!child || child.killed) {
			this.child = null;
			return;
		}
		this.child = null;
		await new Promise<void>((resolve) => {
			let resolved = false;
			const done = () => {
				if (!resolved) {
					resolved = true;
					resolve();
				}
			};
			child.once('exit', done);
			try {
				child.kill('SIGTERM');
			} catch {
				done();
				return;
			}
			// Tight 1s SIGKILL fallback: if a parent process manager imposes
			// its own timeout when stopping us, we want to return before it
			// gives up and SIGKILLs us (which would orphan our child).
			setTimeout(() => {
				try {
					if (!child.killed) child.kill('SIGKILL');
				} catch {
					/* ignore */
				}
				done();
			}, 1_000);
		});
	}
}

// ─── Cloudflare reloader ────────────────────────────────────────────────────

async function createCloudflareReloader(opts: {
	root: string;
	sourceRoot: string;
	port: number;
}): Promise<DevReloader> {
	return new CloudflareReloader(opts);
}

class CloudflareReloader implements DevReloader {
	private server: Awaited<ReturnType<typeof import('vite').createServer>> | null = null;
	private readonly root: string;
	private readonly sourceRoot: string;
	private readonly port: number;
	private readonly configPath: string;
	private readonly entryPath: string;
	url?: string;

	constructor(opts: { root: string; sourceRoot: string; port: number }) {
		this.root = opts.root;
		this.sourceRoot = opts.sourceRoot;
		this.port = opts.port;
		const inputDir = cloudflareViteInputDir(opts.root);
		this.configPath = cloudflareViteConfigPath(opts.root);
		this.entryPath = path.join(inputDir, '_entry.ts');
	}

	async start(): Promise<void> {
		const { createServer } = await import('vite');
		this.server = await createServer({
			...createCloudflareViteConfig(this.root, this.configPath, [this.entryPath]),
			logLevel: 'info',
			server: { host: '127.0.0.1', port: this.port, strictPort: true },
		});
		await this.server.listen();
		this.url =
			this.server.resolvedUrls?.local[0]?.replace(/\/$/, '') ?? `http://127.0.0.1:${this.port}`;
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
		if (buildChanged) await this.server?.restart();
	}

	async stop(): Promise<void> {
		await this.server?.close();
		this.server = null;
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isSourceStructurePath(root: string, sourceRoot: string, relPath: string): boolean {
	const prefix = path.relative(root, sourceRoot).replace(/\\/g, '/');
	const sourceRelative = prefix
		? relPath.startsWith(`${prefix}/`)
			? relPath.slice(prefix.length + 1)
			: null
		: relPath;
	if (sourceRelative === null) return false;
	if (sourceRelative.startsWith('agents/') || sourceRelative.startsWith('workflows/')) return true;
	return /^(?:app|cloudflare)\.(?:ts|mts|js|mjs)$/.test(sourceRelative);
}

function pickExampleAgentName(sourceRoot: string): string | null {
	try {
		const agentsDir = path.join(sourceRoot, 'agents');
		if (!fs.existsSync(agentsDir)) return null;
		for (const entry of fs.readdirSync(agentsDir)) {
			const match = entry.match(/^([a-zA-Z0-9_-]+)\.(ts|js|mts|mjs)$/);
			if (match?.[1]) return match[1];
		}
		return null;
	} catch {
		return null;
	}
}
