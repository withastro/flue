/**
 * The Node application bootstrap, loaded through the Vite graph as
 * `virtual:flue/server`.
 *
 * This is the CLI's generated-entry template
 * (packages/cli/src/lib/build-plugin-node.ts `generateRuntimeEntryPoint`)
 * ported to a real, testable module. Instead of codegen splices it consumes
 * Flue's virtual modules: the user's app (`virtual:flue/app`), the optional
 * persistence adapter (`virtual:flue/db`), and the scanned `'use agent'` set
 * (`virtual:flue/agents`).
 *
 * The registered agent set comes from the scan — `createAgentRouter()`
 * mounts in app.ts are pure routers over it. There are no workflows and no
 * channel-handler registry on this surface: mounting is the dispatch.
 */
import { scannedAgents } from 'virtual:flue/agents';
import userApp from 'virtual:flue/app';
import userPersistenceAdapter from 'virtual:flue/db';
// Registers the configured (or default) provider set; user `setProvider()`
// calls in app.ts win over it regardless of evaluation order.
import 'virtual:flue/providers';
import type { Agent } from '@flue/runtime';
import type {
	AssembledNodeAgentRuntime,
	FlueAgentRegistration,
	PersistenceAdapter,
	RuntimeActivityLease,
} from '@flue/runtime/internal';
import {
	assembleNodeAgentRuntime,
	connectPersistenceAdapter,
	createInstrumentationOwner,
	installDevLifecycleLogger,
	runWithInstrumentationOwner,
} from '@flue/runtime/internal';
import { sqlite } from '@flue/runtime/node';
import { serve } from '@hono/node-server';

export interface LoadFlueNodeApplicationOptions {
	/** Local (dev) mode: dev error rendering, dev SQLite file, lifecycle logs. */
	local?: boolean;
	/** Environment for the runtime; defaults to `process.env`. */
	env?: Record<string, string | undefined>;
}

/** The loaded application's lifecycle surface (admission, drain, shutdown). */
export interface LoadedFlueNodeApplication {
	fetch(request: Request, env?: unknown): Response | Promise<Response>;
	/** Take an activity lease marking an in-flight request; `pauseAdmissions()` rejects new leases. */
	enterActivity(): RuntimeActivityLease;
	/** Stop admitting new durable work (drain phase). */
	pauseAdmissions(): void;
	/** Graceful shutdown: coordinator, instrumentation, persistence. */
	stop(timeoutMs?: number): Promise<void>;
	/** Synchronous best-effort teardown for abnormal exits. */
	closeSync(): void;
}

export interface StartFlueNodeServerOptions extends LoadFlueNodeApplicationOptions {
	port?: number;
	hostname?: string;
	quiet?: boolean;
	signal?: AbortSignal;
	onReady?: () => void;
}

export interface FlueNodeServer {
	stop(): Promise<void>;
	closeSync(): void;
}

/** Build the identity-keyed registration records from the scanned agent set. */
function createAgentRegistrations(): FlueAgentRegistration[] {
	return scannedAgents.map(({ identity, agent }) => ({
		identity,
		agent: agent as Agent,
	}));
}

export async function loadFlueNodeApplication(
	options: LoadFlueNodeApplicationOptions = {},
): Promise<LoadedFlueNodeApplication> {
	const runtimeEnv = options.env ?? process.env;
	const isLocalMode = options.local === true;
	const instrumentationOwner = createInstrumentationOwner();
	let devLifecycle: ReturnType<typeof installDevLifecycleLogger> | undefined;
	let persistenceAdapter: PersistenceAdapter | undefined;
	let assembled: AssembledNodeAgentRuntime | undefined;
	try {
		return await runWithInstrumentationOwner(instrumentationOwner, async () => {
			devLifecycle = isLocalMode ? installDevLifecycleLogger() : undefined;

			// ─── Persistence ──────────────────────────────────────────────
			// Custom persistence from db.ts, or the Node default — in-memory
			// SQLite, process lifetime. Under local dev, FLUE_DEV_SQLITE_PATH
			// points the default at a disk file so conversation history
			// survives reloads (the dev server resets that file on each cold
			// start); ignored outside local mode, so deployed Node stays
			// in-memory. Either way connect() is awaited once at startup so an
			// unreachable or misconfigured database fails at boot, not inside
			// the first request.
			const adapter: PersistenceAdapter =
				userPersistenceAdapter !== undefined
					? (userPersistenceAdapter as PersistenceAdapter)
					: sqlite(
							isLocalMode && runtimeEnv.FLUE_DEV_SQLITE_PATH
								? runtimeEnv.FLUE_DEV_SQLITE_PATH
								: undefined,
						);
			const stores = await connectPersistenceAdapter(
				adapter,
				userPersistenceAdapter !== undefined ? 'db.ts' : 'the default sqlite adapter',
			);
			persistenceAdapter = adapter;

			// ─── Runtime assembly ─────────────────────────────────────────
			// The scan IS the registration: every 'use agent' module joins the
			// app, replacing any previous registration wholesale (reload-safe).
			// The shared assembly wires registration → coordinator → dispatch
			// queue → runtime seed → startup reconciliation; it seeds the
			// runtime before the application is installed into its listener,
			// so routers mounted during app.ts evaluation read the
			// configuration when requests arrive.
			const runtime = await assembleNodeAgentRuntime({
				agents: createAgentRegistrations(),
				adapter,
				stores,
				env: runtimeEnv,
				devMode: isLocalMode,
				...(devLifecycle ? { onInteractionStart: devLifecycle.onAgentInteractionStart } : {}),
			});
			assembled = runtime;
			const { activityGate } = runtime;

			// ─── App composition ──────────────────────────────────────────
			// The user's app.ts default export owns the entire request
			// pipeline; we just verify it exposes a fetch method.
			const flueApp = userApp;
			if (!flueApp || typeof flueApp.fetch !== 'function') {
				throw new Error(
					'[flue] app.ts default export must be a Hono app or an object with a fetch(request) method.',
				);
			}

			let disposing: Promise<void> | undefined;
			return {
				fetch: (request: Request, env?: unknown) => flueApp.fetch(request, env),
				enterActivity() {
					return activityGate.enter();
				},
				pauseAdmissions() {
					activityGate.pause();
				},
				async stop(timeoutMs = 30_000) {
					if (disposing) return disposing;
					disposing = (async () => {
						const errors: unknown[] = [];
						try {
							// Coordinator shutdown, runtime reset, adapter close.
							await runtime.close(timeoutMs);
						} catch (error) {
							errors.push(error);
						}
						try {
							await instrumentationOwner.dispose();
						} catch (error) {
							errors.push(error);
						}
						devLifecycle?.dispose();
						if (errors.length === 1) throw errors[0];
						if (errors.length > 1)
							throw new AggregateError(errors, '[flue] Node application shutdown failed.');
					})();
					return disposing;
				},
				closeSync() {
					devLifecycle?.dispose();
				},
			} satisfies LoadedFlueNodeApplication;
		});
	} catch (error) {
		const cleanupErrors: unknown[] = [];
		try {
			// close() covers the coordinator AND the adapter; before assembly the
			// connected adapter is closed directly.
			if (assembled) await assembled.close();
			else if (persistenceAdapter?.close) await persistenceAdapter.close();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		try {
			await instrumentationOwner.dispose();
		} catch (cleanupError) {
			cleanupErrors.push(cleanupError);
		}
		devLifecycle?.dispose();
		if (cleanupErrors.length)
			throw new AggregateError(
				[error, ...cleanupErrors],
				'[flue] Node application startup failed.',
			);
		throw error;
	}
}

export async function startFlueNodeServer(
	options: StartFlueNodeServerOptions = {},
): Promise<FlueNodeServer> {
	const application = await loadFlueNodeApplication(options);
	const port = options.port ?? 3000;
	let resolveReady!: () => void;
	let rejectReady!: (error: unknown) => void;
	const ready = new Promise<void>((resolve, reject) => {
		resolveReady = resolve;
		rejectReady = reject;
	});
	const server = serve(
		{
			fetch: application.fetch,
			port,
			...(options.hostname ? { hostname: options.hostname } : {}),
			serverOptions: { requestTimeout: 0 },
		},
		() => {
			if (!options.quiet) console.log(`[flue] Server listening on http://localhost:${port}`);
			options.onReady?.();
			resolveReady();
		},
	) as import('node:http').Server;
	const onServerError = (error: Error) => rejectReady(error);
	const onAbort = () => {
		server.closeAllConnections();
		server.close();
		rejectReady(options.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
	};
	server.once('error', onServerError);
	options.signal?.addEventListener('abort', onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	try {
		await ready;
	} catch (error) {
		server.closeAllConnections();
		server.close();
		await application.stop();
		throw error;
	} finally {
		server.off('error', onServerError);
		options.signal?.removeEventListener('abort', onAbort);
	}
	let stopping: Promise<void> | undefined;
	return {
		async stop() {
			if (stopping) return stopping;
			stopping = (async () => {
				const errors: unknown[] = [];
				const httpClosed = new Promise<void>((resolve) =>
					server.close((error) => {
						if (error) errors.push(error);
						resolve();
					}),
				);
				try {
					await application.stop();
				} catch (error) {
					errors.push(error);
				}
				server.closeAllConnections();
				await httpClosed;
				if (errors.length === 1) throw errors[0];
				if (errors.length > 1)
					throw new AggregateError(errors, '[flue] Node server shutdown failed.');
			})();
			return stopping;
		},
		closeSync() {
			server.closeAllConnections();
			server.close();
			application.closeSync();
		},
	};
}
