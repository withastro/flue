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
import * as fs from 'node:fs';
import * as path from 'node:path';
import createDebug from 'debug';
import {
	build,
	discoverAgents,
	discoverChannels,
	discoverWorkflows,
} from './build.ts';
import pc from 'picocolors';
import { createEnvLoader, type EnvLoader, selectEnvFile } from './env.ts';
import {
	type LocalHttpRuntime,
	startBuiltLocalHttpRuntime,
} from './local-http-runtime.ts';
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
	envFile?: string;
	envLoader?: EnvLoader;
	configFiles?: readonly string[];
	configFile?: string;
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
	const port = options.port ?? DEFAULT_DEV_PORT;
	debugDev('starting target=%s root=%s source=%s output=%s port=%d', options.target, root, sourceRoot, output, port);

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

	try {
		if (options.target === 'cloudflare') {
			await envLoader.withApplied(() => build(buildOptions));
		} else {
			await build(buildOptions);
		}
	} catch (err) {
		throw new Error(`Initial build failed: ${err instanceof Error ? err.message : String(err)}`);
	}

	if (options.target === 'cloudflare') envLoader.restore();
	const reloader: DevReloader =
		options.target === 'node'
			? new NodeReloader({ root, output, port })
			: new CloudflareReloader({ root, sourceRoot, port });

	await reloader.start();
	debugDev('ready target=%s url=%s duration=%dms', options.target, reloader.url, Date.now() - startedAt);

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

	// ─── Watch loop ──────────────────────────────────────────────────────────

	const rebuild =
		options.target === 'cloudflare'
			? () => envLoader.withApplied(() => build(buildOptions))
			: () => build(buildOptions);
	const rebuilder = createRebuilder(reloader, rebuild);
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
					error(`Environment reload failed: ${err instanceof Error ? err.message : String(err)}`);
					return;
				}
			}
			devLog(`${pc.dim('changed')} ${relPath}`);
			rebuilder.schedule(isEnvFile);
		},
	});

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	let shuttingDown = false;
	const shutdown = async (_signal: string, exitCode: number) => {
		if (shuttingDown) return;
		shuttingDown = true;
		watcher.close();
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
			devLog(`${pc.dim('rebuilt in')} ${duration}ms`);
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
 *   - `node_modules/`
 *   - Dotfiles and dot-directories (any path segment starting with `.`),
 *     with one exception: `.flue/` is allowed through only when it is the
 *     selected source directory.
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
			if (part.startsWith('.')) return true;
		}
		const base = parts[parts.length - 1] ?? '';
		if (!base) return true;
		if (base.endsWith('~') || base.endsWith('.swp') || base.endsWith('.swx')) return true;
		return false;
	};

	try {
		const w = fs.watch(root, { recursive: true }, (event, filename) => {
			if (!filename) return;
			const rel = filename.toString();
			if (isIgnoredPath(rel)) {
				debugWatch('ignored event=%s path=%s', event, rel);
				return;
			}
			debugWatch('changed event=%s path=%s', event, rel);
			onChange(rel);
		});
		watchers.push(w);
	} catch (err) {
		error(`Failed to watch ${root}: ${err instanceof Error ? err.message : String(err)}`);
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
	private runtime: LocalHttpRuntime | null = null;
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
		debugServer('spawning node server path=%s port=%d', this.serverPath, this.port);
		this.runtime = await startBuiltLocalHttpRuntime({
			target: 'node',
			root: this.root,
			output: path.dirname(this.serverPath),
			port: this.port,
			stopTimeoutMs: 1_000,
			watch: true,
			internalDevLogs: true,
			onOutput: ({ line }) => this.renderLine(line),
			onExit: ({ code, signal }) => {
				if (code !== 0 && code !== null) {
					error(`Node server exited unexpectedly (code=${code}, signal=${signal ?? 'none'})`);
				}
			},
		});
		debugServer('node server ready port=%d', this.port);
	}

	// Node has no downstream watcher — every root change requires a
	// rebuild + child respawn. The watcher's ignore list already filters
	// dist/, node_modules/, etc.
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
		this.runtime?.killSync();
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
		if (line.includes('ExperimentalWarning: SQLite is an experimental feature and might change at any time')) return;
		if (line.trim() === '(Use `node --trace-warnings ...` to show where the warning was created)') return;
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
	url?: string;

	constructor(opts: { root: string; sourceRoot: string; port: number }) {
		this.root = opts.root;
		this.sourceRoot = opts.sourceRoot;
		this.port = opts.port;
	}

	async start(): Promise<void> {
		this.runtime = await startBuiltLocalHttpRuntime({
			target: 'cloudflare',
			root: this.root,
			output: path.join(this.root, 'dist'),
			port: this.port,
			watch: true,
			cloudflareLogLevel: 'info',
		});
		this.url = this.runtime.url;
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
