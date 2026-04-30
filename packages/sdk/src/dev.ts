/**
 * Flue dev server.
 *
 * Watches the user's workspace, rebuilds on file changes, and reloads the
 * underlying server. Distinct from `flue run`: dev is the long-running,
 * edit-and-iterate command, while `flue run` is the one-shot
 * production-style invoker (build → run → exit).
 *
 * # Two very different reload models
 *
 * Node and Cloudflare use fundamentally different rebuild strategies, because
 * what they each provide downstream is fundamentally different:
 *
 * - **Node** has no host bundler. Our esbuild pass produces the final
 *   `dist/server.mjs`. On any change in the workspace we rebuild and respawn
 *   the child Node process. Sub-second restart is fine.
 *
 * - **Cloudflare** uses Wrangler's bundler (the same one `wrangler dev` and
 *   `wrangler deploy` use). Wrangler watches the entry's transitive import
 *   graph itself and reloads workerd on source edits. So we *don't* need to
 *   rebuild for body edits — wrangler handles it. We only need to act when:
 *     1. The set of agents changes (added / removed / triggers changed) →
 *        regenerate `dist/_entry.ts`. Wrangler picks up the new entry
 *        automatically because it's already watching it.
 *     2. The user's `wrangler.jsonc` changes → re-merge our additions and
 *        restart the worker (config changes don't hot-apply).
 *   Pure body edits to agent files: wrangler reloads workerd; we do nothing.
 *
 * # Watching
 *
 * Watching uses `node:fs.watch` recursive (Node 20+). Debounced 150ms. The
 * Node path treats every non-ignored change as a rebuild trigger; the
 * Cloudflare path filters to "structural" changes only.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseEnv } from 'node:util';
import { build } from './build.ts';
import type { BuildOptions } from './types.ts';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DevOptions {
	workspaceDir: string;
	outputDir: string;
	target: 'node' | 'cloudflare';
	/** Defaults to 3583 ("FLUE" on a phone keypad). */
	port?: number;
	/**
	 * Absolute paths to env files (`.env`-format) to load before starting the
	 * dev server. Repeatable; later files override earlier ones on key
	 * collision (matching wrangler's `envFiles` semantics and standard
	 * dotenv composition patterns).
	 *
	 * - Node: parsed with `node:util.parseEnv` and merged into the child
	 *   server process's env. Shell-set env vars win over file values.
	 * - Cloudflare: passed through to wrangler's `unstable_startWorker` as
	 *   `envFiles`, which loads them as `secret_text` bindings.
	 *
	 * If empty/undefined, no env loading happens. Cloudflare's auto-discovery
	 * of `.dev.vars` is disabled in either case (we always pass an explicit
	 * `envFiles` array to wrangler so its default search is suppressed).
	 *
	 * Each path must exist; otherwise dev fails fast with a clear error.
	 */
	envFiles?: string[];
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
	 * Decide whether a workspace file change should trigger a rebuild.
	 * `relPath` is workspace-relative.
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
	const workspaceDir = path.resolve(options.workspaceDir);
	const outputDir = path.resolve(options.outputDir);
	const port = options.port ?? DEFAULT_DEV_PORT;

	// Resolve env files up front so a typo errors before we kick off a build.
	// Resolved against outputDir so relative paths feel natural ("the path
	// they look like from the project root").
	const envFiles = resolveEnvFiles(options.envFiles, outputDir);
	for (const f of envFiles) {
		console.error(`[flue] Loading env from: ${f}`);
	}

	const buildOptions: BuildOptions = {
		workspaceDir,
		outputDir,
		target: options.target,
	};

	console.error(`[flue] Starting dev server (target: ${options.target})`);
	console.error(`[flue] Watching: ${workspaceDir}`);
	console.error(`[flue] Building...`);

	const initialStart = Date.now();
	try {
		await build(buildOptions);
	} catch (err) {
		throw new Error(
			`[flue] Initial build failed: ${err instanceof Error ? err.message : String(err)}`,
		);
	}
	console.error(`[flue] Built in ${Date.now() - initialStart}ms`);

	const reloader: DevReloader =
		options.target === 'node'
			? new NodeReloader({ outputDir, port, envFiles })
			: await createCloudflareReloader({ outputDir, port, envFiles });

	await reloader.start();

	if (reloader.url) {
		console.error(`[flue] Server: ${reloader.url}`);
		const exampleAgent = pickExampleAgentName(outputDir, workspaceDir);
		if (exampleAgent) {
			console.error(`[flue] Try: curl -X POST ${reloader.url}/agents/${exampleAgent}/test-1 \\`);
			console.error(`         -H 'Content-Type: application/json' -d '{}'`);
		}
	}
	console.error(`[flue] Press Ctrl+C to stop\n`);

	// ─── Watch loop ──────────────────────────────────────────────────────────

	const rebuilder = createRebuilder(buildOptions, reloader);
	const envFileSet = new Set(envFiles);
	const watcher = createWatcher({
		workspaceDir,
		outputDir,
		target: options.target,
		envFiles,
		onChange: (relPath) => {
			if (!reloader.shouldRebuildOn(relPath)) return;
			const isEnvFile = envFileSet.has(relPath);
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
	 * told `buildChanged: true` even if the build wrote nothing new. This is
	 * how env-file edits trigger a worker restart on the Cloudflare path:
	 * the build is unchanged but the runtime needs the new env values.
	 */
	schedule(forceReload?: boolean): void;
}

function createRebuilder(buildOptions: BuildOptions, reloader: DevReloader): Rebuilder {
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
			const { changed } = await build(buildOptions);
			await reloader.reload(changed || force);
			console.error(`[flue] Reloaded in ${Date.now() - start}ms\n`);
		} catch (err) {
			// Don't exit the dev loop on a rebuild error — the user is editing
			// code, they'll fix it and trigger another rebuild.
			console.error(
				`[flue] Rebuild failed: ${err instanceof Error ? err.message : String(err)}\n`,
			);
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
	workspaceDir: string;
	outputDir: string;
	target: 'node' | 'cloudflare';
	/** Absolute paths of env files to watch. Empty means none. */
	envFiles: string[];
	onChange: (relPath: string) => void;
}

interface WatcherHandle {
	close(): void;
}

/**
 * Watch the workspace for changes. Uses `fs.watch` recursive (Node 20+).
 *
 * Watched roots:
 *   - `<workspaceDir>` — agents/, roles/, AGENTS.md, .agents/skills/.
 *   - For Cloudflare: also `<outputDir>/wrangler.jsonc` (and `.json`),
 *     since changes there require a worker restart.
 *
 * Ignored:
 *   - `dist/`, `node_modules/`, `.git/`, `.turbo/`
 *   - dotfiles other than the ones we explicitly care about (AGENTS.md is
 *     not a dotfile, so it's fine)
 *   - editor backup/swap suffixes
 */
function createWatcher(options: WatcherOptions): WatcherHandle {
	const { workspaceDir, outputDir, target, envFiles, onChange } = options;
	const watchers: fs.FSWatcher[] = [];

	const isIgnoredPath = (relPath: string): boolean => {
		const normalized = relPath.replace(/\\/g, '/');
		const parts = normalized.split('/');
		for (const part of parts) {
			if (part === 'node_modules') return true;
			if (part === 'dist') return true;
			if (part === '.git') return true;
			if (part === '.turbo') return true;
		}
		const base = parts[parts.length - 1] ?? '';
		if (!base) return true;
		if (base.startsWith('.') && base !== '.flueignore') return true;
		if (base.endsWith('~') || base.endsWith('.swp') || base.endsWith('.swx')) return true;
		if (base === '.DS_Store') return true;
		return false;
	};

	try {
		const w = fs.watch(workspaceDir, { recursive: true }, (_event, filename) => {
			if (!filename) return;
			const rel = filename.toString();
			if (isIgnoredPath(rel)) return;
			onChange(rel);
		});
		watchers.push(w);
	} catch (err) {
		console.error(
			`[flue] Failed to watch ${workspaceDir}: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	if (target === 'cloudflare') {
		// Watch all three formats wrangler accepts. We only set up watchers
		// for files that exist today — if a user adds a wrangler.* file later
		// they'll need to restart the dev server. That trade-off keeps the
		// watcher logic simple and avoids polling for non-existent files.
		for (const cfgName of ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml']) {
			const cfgPath = path.join(outputDir, cfgName);
			if (!fs.existsSync(cfgPath)) continue;
			try {
				const w = fs.watch(cfgPath, () => onChange(cfgName));
				watchers.push(w);
			} catch {
				// Best-effort; continue without this watch.
			}
		}
	}

	// Watch user-supplied env files. Edits trigger a full reload (respawn
	// child for Node; dispose+restart worker for Cloudflare) since env
	// values affect runtime behavior the bundler can't see. Path passed to
	// onChange is the absolute path so the reload-decision code can match
	// against the resolved set deterministically.
	for (const envPath of envFiles) {
		try {
			const w = fs.watch(envPath, () => onChange(envPath));
			watchers.push(w);
		} catch {
			// Best-effort; continue without this watch.
		}
	}

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
	private readonly outputDir: string;
	private readonly port: number;
	private readonly envFiles: string[];
	url: string;

	constructor(opts: { outputDir: string; port: number; envFiles: string[] }) {
		this.outputDir = opts.outputDir;
		this.port = opts.port;
		this.envFiles = opts.envFiles;
		this.serverPath = path.join(this.outputDir, 'dist', 'server.mjs');
		this.url = `http://localhost:${this.port}`;
	}

	async start(): Promise<void> {
		await this.spawnAndWait();
	}

	// Node has no downstream watcher — every workspace change requires a
	// rebuild + child respawn. The watcher's ignore list already filters
	// dist/, node_modules/, etc.
	shouldRebuildOn(_relPath: string): boolean {
		return true;
	}

	async reload(_buildChanged: boolean): Promise<void> {
		// On Node we always restart the child. The bundled `server.mjs` is
		// re-emitted by esbuild on every build (we don't dedupe there), so
		// `buildChanged` is effectively always true. Even if it weren't, the
		// child has the old code loaded in memory — to pick up new code it
		// must restart.
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
		// Compose env: parsed env-file values first, then process.env on top so
		// shell-set vars win over file values (matches dotenv-cli convention),
		// then explicit Flue overrides last. Re-read env files on every spawn
		// so mid-session edits to the file are picked up on the next reload.
		const fromFiles = parseEnvFiles(this.envFiles);
		const child = spawn('node', [this.serverPath], {
			stdio: ['ignore', 'pipe', 'pipe'],
			cwd: this.outputDir,
			// FLUE_MODE=local lets the dev server invoke trigger-less agents over
			// HTTP (useful when iterating on CI-only agents locally). Mirrors
			// the behavior of `flue run`.
			env: {
				...fromFiles,
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

		const ready = await waitForHealth(this.url, 15_000);
		if (!ready) {
			await this.killChild();
			throw new Error('Node server did not become ready within 15s');
		}
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

/**
 * Lazy-import wrangler so users targeting only Node don't need it installed.
 * If the import fails, surface a friendly message pointing at the peer-dep.
 */
async function createCloudflareReloader(opts: {
	outputDir: string;
	port: number;
	envFiles: string[];
}): Promise<DevReloader> {
	let wrangler: typeof import('wrangler');
	try {
		wrangler = (await import('wrangler')) as typeof import('wrangler');
	} catch (err) {
		throw new Error(
			`[flue] Cloudflare dev requires the "wrangler" package as a peer dependency.\n` +
				`Install it in your project:\n\n` +
				`  npm install --save-dev wrangler\n\n` +
				`Underlying error: ${err instanceof Error ? err.message : String(err)}`,
		);
	}

	return new CloudflareReloader(wrangler, opts);
}

class CloudflareReloader implements DevReloader {
	private worker: Awaited<ReturnType<typeof import('wrangler').unstable_startWorker>> | null =
		null;
	private readonly wrangler: typeof import('wrangler');
	private readonly outputDir: string;
	private readonly port: number;
	private readonly configPath: string;
	private readonly envFiles: string[];
	url?: string;

	constructor(
		wrangler: typeof import('wrangler'),
		opts: { outputDir: string; port: number; envFiles: string[] },
	) {
		this.wrangler = wrangler;
		this.outputDir = opts.outputDir;
		this.port = opts.port;
		this.envFiles = opts.envFiles;
		this.configPath = path.join(this.outputDir, 'dist', 'wrangler.jsonc');
	}

	async start(): Promise<void> {
		await this.startWorker();
	}

	/**
	 * On Cloudflare, wrangler watches the entry's transitive imports itself
	 * and hot-reloads workerd when an agent file body changes. We only need
	 * to act when something *structural* changes — i.e. something that
	 * affects what `_entry.ts` or `wrangler.jsonc` look like.
	 *
	 * Concretely, we trigger a Flue-side rebuild for:
	 *   - File adds/removes in `agents/` (the agent set determines DO classes
	 *     and binding declarations).
	 *   - Changes to `agents/*.ts` — these MAY change the exported `triggers`,
	 *     so we have to re-parse them. (Plain body edits redo a tiny amount
	 *     of work but the rebuild is cheap and idempotent.)
	 *   - Changes to `roles/*.md` — roles are baked into the entry as JSON.
	 *   - Changes to the user's `wrangler.jsonc` — affects the merged config.
	 *
	 * Notes we explicitly DO ignore for rebuild purposes (wrangler handles
	 * them): edits to imported source files outside of `agents/`/`roles/`,
	 * AGENTS.md, and `.agents/skills/` (those are runtime-discovered, not
	 * baked into the entry).
	 */
	shouldRebuildOn(relPath: string): boolean {
		// Env-file changes come through the watcher as absolute paths — match
		// directly against our resolved set rather than the workspace-relative
		// suffix logic used for source files.
		if (this.envFiles.includes(relPath)) return true;

		const normalized = relPath.replace(/\\/g, '/');
		if (
			normalized === 'wrangler.jsonc' ||
			normalized === 'wrangler.json' ||
			normalized === 'wrangler.toml'
		) {
			return true;
		}
		if (normalized.startsWith('agents/')) return true;
		if (normalized.startsWith('roles/')) return true;
		return false;
	}

	async reload(buildChanged: boolean): Promise<void> {
		// The whole point of the Cloudflare path: most edits hit `agents/`
		// bodies, and wrangler's bundler reloads workerd on its own when an
		// imported source file changes. So if the build itself wrote nothing
		// new (entry + wrangler.jsonc both byte-identical), there's nothing
		// for us to do — wrangler is already on it.
		//
		// We only restart the worker when the build actually changed
		// something — that signals a structural change (new agent, removed
		// agent, triggers changed, user edited wrangler.jsonc) that
		// wrangler's source watcher can't apply hot.
		if (!buildChanged) {
			console.error(`[flue] No structural change — wrangler will hot-reload\n`);
			return;
		}
		await this.disposeWorker();
		await this.startWorker();
	}

	async stop(): Promise<void> {
		await this.disposeWorker();
	}

	killSync(): void {
		// `unstable_startWorker` runs `workerd` as a child process, but we
		// have no synchronous handle to it from this layer. The parent's
		// exit cascades to workerd via shared process group on macOS/Linux.
		this.worker = null;
	}

	// ── Internals ──

	private async startWorker(): Promise<void> {
		if (!fs.existsSync(this.configPath)) {
			throw new Error(
				`[flue] Expected ${this.configPath} after build, but it doesn't exist. ` +
					`Did the Cloudflare build succeed?`,
			);
		}

		// `unstable_startWorker` requires `build.nodejsCompatMode` to be set
		// explicitly — it doesn't derive it from `compatibility_flags` in the
		// config (that's the caller's job; wrangler's own CLI passes a hook).
		//
		// We hardcode `'v2'` because Flue's invariants make it the only
		// correct value for any Flue worker:
		//   - `validateUserWranglerConfig` rejects configs whose
		//     `compatibility_flags` is set without `nodejs_compat`.
		//   - `mergeFlueAdditions` adds `nodejs_compat` when missing.
		//   - `compatibility_date` is floored at `MIN_COMPATIBILITY_DATE`
		//     (2026-04-01), well past the v1→v2 cutover (2024-09-23).
		//
		// So at the point this runs, the merged dist/wrangler.jsonc is
		// guaranteed to have `nodejs_compat` set with a compat date that
		// resolves to v2 mode. Reading the config to compute it would just
		// re-derive the constant on every reload.
		// Always pass an explicit `envFiles` array (even if empty). Per
		// wrangler's docs: "If `envFiles` is defined, only the files in the
		// array will be considered for loading local dev variables." So an
		// explicit `[]` fully disables wrangler's auto-discovery (which by
		// default would hunt in the dist/ dir for `.dev.vars` and `.env*` —
		// the wrong place since our config lives there but the user's env
		// files don't).
		//
		// Users opt into env loading via `--env <path>` on the CLI.
		// Paths come in as absolute (resolved + existence-checked at the
		// `dev()` entry point), so wrangler's "relative to config dir"
		// resolution doesn't apply.
		this.worker = await this.wrangler.unstable_startWorker({
			config: this.configPath,
			envFiles: this.envFiles,
			build: {
				nodejsCompatMode: 'v2',
			},
			dev: {
				server: {
					hostname: 'localhost',
					port: this.port,
				},
				// We drive structural reloads via our own watcher. wrangler's
				// own source-graph watcher remains active inside the worker
				// (it's what gives us hot-reload on agent body edits).
				watch: false,
				logLevel: 'info',
			},
		});

		try {
			const url = await this.worker.url;
			this.url = url.toString().replace(/\/$/, '');
		} catch {
			this.url = `http://127.0.0.1:${this.port}`;
		}
	}

	private async disposeWorker(): Promise<void> {
		const worker = this.worker;
		this.worker = null;
		if (!worker) return;
		try {
			await worker.dispose();
		} catch (err) {
			console.error(
				`[flue] Error disposing Cloudflare worker: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve and validate a list of env-file paths. Returns absolute paths.
 *
 * Throws a friendly `[flue]`-prefixed error if any path doesn't exist. The
 * goal of `--env` is explicitness — silent skip on a typo would defeat
 * the purpose.
 */
export function resolveEnvFiles(envFiles: string[] | undefined, cwd: string): string[] {
	if (!envFiles || envFiles.length === 0) return [];
	return envFiles.map((p) => {
		const abs = path.isAbsolute(p) ? p : path.resolve(cwd, p);
		if (!fs.existsSync(abs)) {
			throw new Error(`[flue] --env points at a path that doesn't exist: ${p}`);
		}
		return abs;
	});
}

/**
 * Parse one or more `.env`-format files and return their merged contents.
 * Later files override earlier files on key collision.
 *
 * Uses Node's built-in `util.parseEnv` (Node 20.6+; Flue requires Node 22+).
 * No `dotenv` package needed.
 *
 * Parse-only — doesn't touch `process.env`. Caller composes with
 * `process.env` as needed (typical pattern: spread file vars first, then
 * `process.env`, so shell-set values win).
 */
export function parseEnvFiles(absolutePaths: string[]): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const p of absolutePaths) {
		const content = fs.readFileSync(p, 'utf-8');
		const parsed = parseEnv(content) as Record<string, string>;
		Object.assign(merged, parsed);
	}
	return merged;
}

async function waitForHealth(baseUrl: string, timeoutMs: number): Promise<boolean> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 1_000);
			const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
			clearTimeout(timeout);
			if (res.ok) return true;
		} catch {
			// Not ready yet.
		}
		await new Promise((r) => setTimeout(r, 200));
	}
	return false;
}

/**
 * Pick a webhook agent name to print in the friendly curl example. Falls back
 * to any agent if none have webhook triggers (the example would 404 on the
 * dev server in that case, but it's still a hint at the URL shape). Reads the
 * manifest written by the build, with a directory-scan fallback in case the
 * manifest is somehow missing.
 *
 * Best-effort — silently returns null if anything goes wrong.
 */
function pickExampleAgentName(outputDir: string, workspaceDir: string): string | null {
	type ManifestEntry = { name: string; triggers?: { webhook?: boolean; cron?: string } };
	try {
		const manifestPath = path.join(outputDir, 'dist', 'manifest.json');
		if (fs.existsSync(manifestPath)) {
			const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8')) as {
				agents?: ManifestEntry[];
			};
			const agents = manifest.agents ?? [];
			const webhook = agents.find((a) => a.triggers?.webhook);
			if (webhook) return webhook.name;
			if (agents[0]) return agents[0].name;
		}
	} catch {
		// Fall through to filesystem scan.
	}

	try {
		const agentsDir = path.join(workspaceDir, 'agents');
		if (!fs.existsSync(agentsDir)) return null;
		for (const e of fs.readdirSync(agentsDir)) {
			const m = e.match(/^([a-zA-Z0-9_-]+)\.(ts|js|mts|mjs)$/);
			if (m && m[1]) return m[1];
		}
		return null;
	} catch {
		return null;
	}
}
