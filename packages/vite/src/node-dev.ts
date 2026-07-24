/**
 * Node dev integration: loads the bootstrap (`virtual:flue/server`) through
 * the outer Vite dev server's SSR module loader and serves the application
 * behind a Fetch-compatible connect middleware.
 *
 * The admission/lease semantics were originally ported from the CLI's stable
 * listener: the app is only reachable in the `ready` state, observation
 * requests bypass activity leasing, and streamed response bodies retain
 * their lease until fully consumed.
 *
 * Reload semantics: on relevant module invalidation the controller loads the
 * NEW application first and stops the old one after the swap
 * (load-new-then-stop-old). A failed load keeps the previous application
 * serving (or renders the canonical 503 envelope when there is none) and
 * recovers on the next successful edit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	configureErrorRendering,
	RuntimeUnavailableError,
	toHttpResponse,
} from '@flue/runtime/internal';
import { getRequestListener } from '@hono/node-server';
import type { ViteDevServer } from 'vite';
import type {
	LoadedFlueNodeApplication,
	LoadFlueNodeApplicationOptions,
} from './bootstrap/node-server.ts';

type NodeRuntimeStatus = 'loading' | 'ready' | 'failed' | 'closed';

const RELOAD_DEBOUNCE_MS = 150;

export interface NodeDevController {
	/** Connect-style request handler serving the loaded application. */
	handleRequest(
		req: import('node:http').IncomingMessage,
		res: import('node:http').ServerResponse,
	): void;
	/** Debounced, serialized (re)load of the application. */
	scheduleReload(): void;
	/** Kick off the initial load immediately. */
	start(): void;
	/** Stop the application; the controller refuses further loads. */
	close(): Promise<void>;
}

export function createNodeDevController(options: {
	server: ViteDevServer;
	/** Absolute project root (for the dev SQLite cache location). */
	root: string;
	/**
	 * Supplementary diagnostic for a load failure (e.g. the import chain of a
	 * wrong-environment module), appended to the logged error and the 503
	 * envelope's dev field.
	 */
	explainLoadError?: (error: unknown) => string | undefined;
}): NodeDevController {
	const { server, root } = options;
	const logger = server.config.logger;

	// Back the dev conversation store with an on-disk SQLite file so history
	// survives reloads within a session. Reset it on each cold start so a
	// fresh dev server begins empty (WAL mode adds the -wal/-shm sidecars).
	const devDbPath = path.join(root, 'node_modules', '.cache', 'flue', 'dev.db');
	for (const suffix of ['', '-wal', '-shm']) fs.rmSync(devDbPath + suffix, { force: true });

	let status: NodeRuntimeStatus = 'loading';
	let application: LoadedFlueNodeApplication | undefined;
	let closed = false;
	let queue: Promise<void> = Promise.resolve();
	let debounceTimer: ReturnType<typeof setTimeout> | undefined;
	let queued = false;
	let lastLoadError: string | undefined;

	// This controller only exists under `vite dev`, so error envelopes may
	// carry their dev-audience prose even before the application (which
	// normally configures rendering) has loaded once.
	configureErrorRendering({ devMode: true });

	function enqueue(operation: () => Promise<void>): Promise<void> {
		const next = queue.then(operation, operation);
		queue = next.catch(() => undefined);
		return next;
	}

	async function loadOnce(): Promise<void> {
		if (closed) return;
		queued = false;
		if (!application) status = 'loading';
		try {
			const bootstrap = (await server.ssrLoadModule('virtual:flue/server', {
				fixStacktrace: true,
			})) as {
				loadFlueNodeApplication(
					options: LoadFlueNodeApplicationOptions,
				): Promise<LoadedFlueNodeApplication>;
			};
			const loaded = await bootstrap.loadFlueNodeApplication({
				local: true,
				env: { ...process.env, FLUE_DEV_SQLITE_PATH: devDbPath },
			});
			if (closed) {
				await loaded.stop();
				return;
			}
			const previous = application;
			application = loaded;
			status = 'ready';
			if (lastLoadError !== undefined) {
				lastLoadError = undefined;
				logger.info('[flue] Application load recovered.');
			}
			if (previous) {
				// Load-new-then-stop-old: the swap happened above, so in-flight
				// requests on the previous application drain on their own clock.
				try {
					await previous.stop(30_000);
				} catch (error) {
					logger.error(`[flue] Previous application shutdown failed: ${formatError(error)}`, {
						error: asError(error),
					});
				}
			}
		} catch (error) {
			// A failed load keeps the previous application serving (when there is
			// one); the next successful edit recovers. Remap SSR stack frames to
			// authored sources before the error is logged or rendered.
			fixLoadErrorStack(server, error);
			const explanation = options.explainLoadError?.(error);
			lastLoadError = [error instanceof Error ? error.message : String(error), explanation]
				.filter(Boolean)
				.join('\n');
			logger.error(
				`[flue] Application load failed: ${formatError(error)}${explanation ? `\n${explanation}` : ''}`,
				{ error: asError(error) },
			);
			if (!application) status = 'failed';
		}
	}

	async function handle(request: Request): Promise<Response> {
		if (status !== 'ready' || !application) {
			const state = status === 'closed' || status === 'failed' ? 'failed' : 'loading';
			// Dev-only server: surface the load failure to the requester instead
			// of making them tail the terminal. Null bytes (virtual module ids in
			// stacks) would make the response fail to serialize.
			const dev =
				state === 'failed' && lastLoadError !== undefined
					? `Application load failed: ${lastLoadError.replaceAll('\0', '')}`
					: undefined;
			return toHttpResponse(new RuntimeUnavailableError({ state, ...(dev ? { dev } : {}) }));
		}
		if (isObservationRequest(request)) return application.fetch(request);
		const lease = application.enterActivity();
		try {
			const response = await application.fetch(request);
			return retainLeaseForResponse(response, lease);
		} catch (error) {
			lease.release();
			throw error;
		}
	}

	const requestListener = getRequestListener((request) => handle(request));

	return {
		handleRequest(req, res) {
			void requestListener(req, res);
		},
		scheduleReload() {
			if (closed) return;
			if (debounceTimer) clearTimeout(debounceTimer);
			debounceTimer = setTimeout(() => {
				debounceTimer = undefined;
				if (queued) return;
				queued = true;
				void enqueue(loadOnce);
			}, RELOAD_DEBOUNCE_MS);
		},
		start() {
			void enqueue(loadOnce);
		},
		close() {
			if (debounceTimer) clearTimeout(debounceTimer);
			return enqueue(async () => {
				if (closed) return;
				closed = true;
				status = 'closed';
				const current = application;
				application = undefined;
				if (!current) return;
				current.pauseAdmissions();
				try {
					await current.stop(30_000);
				} catch (error) {
					logger.error(`[flue] Application shutdown failed: ${formatError(error)}`, {
						error: asError(error),
					});
				}
			});
		},
	};
}

/**
 * GET/HEAD reads of health endpoints and agent conversation streams observe
 * the runtime rather than adding work; they bypass activity leasing so
 * long-lived observation streams never block a drain.
 */
function isObservationRequest(request: Request): boolean {
	if (request.method !== 'GET' && request.method !== 'HEAD') return false;
	const pathname = new URL(request.url).pathname;
	return (
		/\/(?:healthz?|readyz?|livez?)$/.test(pathname) || /\/agents\/[^/]+\/[^/]+$/.test(pathname)
	);
}

function retainLeaseForResponse(response: Response, lease: { release(): void }): Response {
	if (!response.body) {
		lease.release();
		return response;
	}
	const reader = response.body.getReader();
	return new Response(
		new ReadableStream<Uint8Array>({
			async pull(controller) {
				try {
					const result = await reader.read();
					if (result.done) {
						lease.release();
						controller.close();
						return;
					}
					controller.enqueue(result.value);
				} catch (error) {
					lease.release();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					lease.release();
				}
			},
		}),
		{
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		},
	);
}

/**
 * Best-effort SSR stack remapping so load-failure frames point at authored
 * sources instead of transformed code. `ssrFixStacktrace` can itself throw on
 * exotic runtimes; the original error must survive that.
 */
function fixLoadErrorStack(server: ViteDevServer, error: unknown): void {
	if (!(error instanceof Error)) return;
	try {
		server.ssrFixStacktrace(error);
	} catch {
		// Keep the unmapped stack.
	}
}

function formatError(error: unknown): string {
	return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
