/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import type { FlueContextInternal } from '../client.ts';
import { parseJsonBody, toHttpResponse } from '../errors.ts';
import type { FlueEvent } from '../types.ts';
import { generateRunId } from './ids.ts';
import type { RunRegistry } from './run-registry.ts';
import type { RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

/**
 * Agent handler signature — the default export of a `.flue/agents/<name>.ts`
 * file. Receives a context, may return any JSON-serializable value (or
 * undefined for fire-and-forget agents).
 */
export type AgentHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

/**
 * Caller-provided context factory. Differs per-target:
 *   - Node: env=process.env, defaultStore=in-memory, no resolveSandbox.
 *   - Cloudflare: env=DO env, defaultStore=DO SQLite, resolveSandbox=cfSandboxToSessionEnv.
 */
export type CreateContextFn = (
	id: string,
	runId: string,
	payload: unknown,
	request: Request,
) => FlueContextInternal;

/**
 * Webhook execution wrapper. Receives the prepared run callback and returns
 * a promise that resolves with the handler's return value. Implementations:
 *
 *   - Node: just `run()` — no fiber, no DO.
 *   - Cloudflare: `doInstance.runFiber('flue:webhook:<runId>', run)`.
 *
 * The caller is responsible for any logging on completion/error; this routine
 * just kicks it off and returns the 202.
 */
export type StartWebhookFn = (runId: string, run: () => Promise<unknown>) => Promise<unknown>;

/**
 * Foreground handler execution wrapper. Wraps the call to `handler(ctx)` so
 * targets can layer in keepalive / context propagation. Defaults to direct
 * invocation when omitted.
 */
export type RunHandlerFn = (
	ctx: FlueContextInternal,
	handler: AgentHandler,
) => unknown | Promise<unknown>;

export interface HandleAgentOptions {
	/** Standard Fetch Request. */
	request: Request;
	/**
	 * The agent name (URL segment). Used only in webhook completion / error
	 * log lines — routing has already happened by the time we get here.
	 */
	agentName: string;
	/** Agent id (URL segment / DO room name). */
	id: string;
	/** The agent's default-export handler. */
	handler: AgentHandler;
	/** Per-target context factory. */
	createContext: CreateContextFn;
	/**
	 * Per-target webhook runner. If omitted, fire-and-forget executes the
	 * prepared `run` callback directly (Node default — handler runs in the
	 * same process as the request handler). On Cloudflare the caller MUST
	 * provide this with a `runFiber` wrapper so the handler survives DO
	 * hibernation between the 202 ack and the actual completion.
	 */
	startWebhook?: StartWebhookFn;
	/**
	 * Per-target foreground handler wrapper. If omitted, the handler is
	 * invoked directly (Node default). On Cloudflare this is a
	 * `runWithCloudflareContext` + `keepAliveWhile` wrapper that propagates
	 * `env` via AsyncLocalStorage and prevents the DO from hibernating
	 * mid-stream.
	 */
	runHandler?: RunHandlerFn;
	/** Per-target run history store. If omitted, run persistence is disabled. */
	runStore?: RunStore;
	/**
	 * Per-target in-process subscriber registry used by the run-stream
	 * route to live-tail an active run. Optional — if omitted, the run
	 * still produces events and is persisted, but live-tail subscribers
	 * see only what's already in the store at the moment they connect.
	 */
	runSubscribers?: RunSubscriberRegistry;
	/**
	 * Per-target cross-deployment pointer index. Receives a
	 * `recordRunStart` after every successful `createRun` and a
	 * `recordRunEnd` after every `endRun`. Optional — if omitted, the
	 * run still completes; only the bare `/runs/:runId` lookup path
	 * (which consults the registry to discover the owning instance)
	 * will be unable to find this run.
	 */
	runRegistry?: RunRegistry;
}

/**
 * Dispatch a single `/agents/:name/:id` request. The mode is chosen by
 * inspecting headers:
 *
 *   - `X-Webhook: true` → fire-and-forget. Returns 202 immediately; the
 *     handler runs in the background. Errors are logged server-side.
 *   - `Accept: text/event-stream` (and not webhook) → SSE streaming. Returns
 *     200 + text/event-stream. Events come from the FlueContext's event
 *     callback; final result is appended as `event: result`. Per-event errors
 *     surface as `event: error` envelopes.
 *   - Otherwise → sync. Returns 200 + JSON `{ result }`.
 *
 * Errors thrown BEFORE streaming starts (body parse, agent lookup) bubble
 * out as a `Response` via {@link toHttpResponse} — headers haven't been sent
 * yet, so a regular HTTP error is still possible. Errors thrown AFTER the
 * 200 + text/event-stream headers are on the wire (i.e. inside the agent
 * handler) get framed as in-stream `error` events instead.
 *
 * Caller is responsible for routing — this function assumes the request has
 * already been validated as a POST against a registered agent.
 */
export async function handleAgentRequest(opts: HandleAgentOptions): Promise<Response> {
	const { request, agentName, id, handler, createContext, runStore, runSubscribers, runRegistry } =
		opts;
	const startWebhook = opts.startWebhook ?? defaultStartWebhook;
	const runHandler = opts.runHandler ?? defaultRunHandler;
	const runId = generateRunId();

	try {
		// Parse the request body. Throws on invalid Content-Type or malformed
		// JSON; returns {} for genuinely empty bodies (so no-payload agents
		// still work).
		const payload = await parseJsonBody(request);

		const accept = request.headers.get('accept') || '';
		const isWebhook = request.headers.get('x-webhook') === 'true';
		const isSSE = accept.includes('text/event-stream') && !isWebhook;

		if (isWebhook) {
			return runWebhookMode({
				agentName,
				id,
				runId,
				handler,
				payload,
				request,
				createContext,
				startWebhook,
				runStore,
				runSubscribers,
				runRegistry,
			});
		}

		if (isSSE) {
			return runSseMode({
				agentName,
				id,
				runId,
				handler,
				payload,
				request,
				createContext,
				runHandler,
				runStore,
				runSubscribers,
				runRegistry,
			});
		}

		return runSyncMode({
			agentName,
			id,
			runId,
			handler,
			payload,
			request,
			createContext,
			runHandler,
			runStore,
			runSubscribers,
			runRegistry,
		});
	} catch (err) {
		// toHttpResponse logs unknowns via flueLog.error — no extra console.error
		// needed at this layer.
		const response = toHttpResponse(err);
		response.headers.set('X-Flue-Run-Id', runId);
		return response;
	}
}

// ─── Mode implementations ───────────────────────────────────────────────────

interface ModeOptions {
	agentName: string;
	id: string;
	runId: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runHandler: RunHandlerFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

interface WebhookOptions {
	agentName: string;
	id: string;
	runId: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWebhook: StartWebhookFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

async function runWebhookMode(opts: WebhookOptions): Promise<Response> {
	const {
		agentName,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		startWebhook,
		runStore,
		runSubscribers,
		runRegistry,
	} = opts;

	// Webhook mode relies on `startWebhook` for target-specific execution
	// context (`runFiber` on Cloudflare), so it does not also use `runHandler`.
	const lifecycle = await createRunLifecycle({
		agentName,
		id,
		runId,
		payload,
		request,
		createContext,
		runStore,
		runSubscribers,
		runRegistry,
	});
	const { ctx } = lifecycle;
	const run = async (): Promise<unknown> => withRunLifecycle(lifecycle, () => handler(ctx));

	startWebhook(runId, run).then(
		(result) => {
			console.log(
				'[flue] Webhook handler complete:',
				agentName,
				result !== undefined ? JSON.stringify(result) : '(no return)',
			);
		},
		(err) => {
			console.error('[flue] Webhook handler error:', agentName, err);
		},
	);

	return new Response(JSON.stringify({ status: 'accepted', runId }), {
		status: 202,
		headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': runId },
	});
}

/**
 * Shared heartbeat interval for SSE streams.
 */
export const SSE_HEARTBEAT_MS = 15_000;

function runSseMode(opts: ModeOptions): Response {
	const {
		agentName,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		runHandler,
		runStore,
		runSubscribers,
		runRegistry,
	} = opts;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	let isIdle = false;
	let closed = false;

	// Writes after client disconnect are intentionally dropped; the handler
	// should still finish so run history can be finalized.
	const writeSSE = async (data: unknown, eventType: string): Promise<void> => {
		if (closed) return;
		const eventIndex = getEventIndex(data) ?? 0;
		const lines: string[] = [];
		lines.push(`event: ${eventType}`);
		lines.push(`id: ${eventIndex}`);
		lines.push(`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`);
		lines.push('', '');
		try {
			await writer.write(encoder.encode(lines.join('\n')));
		} catch {
		}
	};

	const writeHeartbeat = async (): Promise<void> => {
		if (closed) return;
		try {
			await writer.write(encoder.encode(': heartbeat\n\n'));
		} catch {
		}
	};

	const heartbeat = setInterval(() => {
		writeHeartbeat().catch(() => {});
	}, SSE_HEARTBEAT_MS);

	(async () => {
		const lifecycle = await createRunLifecycle({
			agentName,
			id,
			runId,
			payload,
			request,
			createContext,
			runStore,
			runSubscribers,
			runRegistry,
		});
		const { ctx } = lifecycle;
		ctx.setEventCallback((event) => {
			if (event.type === 'idle') isIdle = true;
			writeSSE(event, event.type).catch(() => {});
		});

		try {
			await withRunLifecycle(lifecycle, async () => {
				try {
					return await runHandler(ctx, handler);
				} finally {
					// Keep idle before the terminal run event on the SSE wire.
					if (!isIdle) ctx.emitEvent({ type: 'idle' });
				}
			});
		} catch {
			// The lifecycle wrapper has already emitted the terminal event.
		} finally {
			clearInterval(heartbeat);
			ctx.setEventCallback(undefined);
			closed = true;
			try {
				await writer.close();
			} catch {
				// Already closed by the client / runtime — nothing to do.
			}
		}
	})();

	return new Response(readable, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
			'X-Flue-Run-Id': runId,
		},
	});
}

async function runSyncMode(opts: ModeOptions): Promise<Response> {
	const {
		agentName,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		runHandler,
		runStore,
		runSubscribers,
		runRegistry,
	} = opts;
	const lifecycle = await createRunLifecycle({
		agentName,
		id,
		runId,
		payload,
		request,
		createContext,
		runStore,
		runSubscribers,
		runRegistry,
	});
	const { ctx } = lifecycle;
	try {
		const result = await withRunLifecycle(lifecycle, () => runHandler(ctx, handler));
		return new Response(
			JSON.stringify({ result: result === undefined ? null : result, _meta: { runId } }),
			{ headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': runId } },
		);
	} finally {
		ctx.setEventCallback(undefined);
	}
}

// ─── Run lifecycle ──────────────────────────────────────────────────────────

interface RunLifecycleOptions {
	agentName: string;
	id: string;
	runId: string;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

interface RunLifecycle extends RunLifecycleOptions {
	ctx: FlueContextInternal;
	startedAt: string;
	startedAtMs: number;
}

async function createRunLifecycle(options: RunLifecycleOptions): Promise<RunLifecycle> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const ctx = options.createContext(options.id, options.runId, options.payload, options.request);
	const runStore = options.runStore;
	const didCreateRun = runStore
		? await safeRunStore('createRun', () =>
			runStore.createRun({
				runId: options.runId,
				instanceId: options.id,
				agentName: options.agentName,
				startedAt,
				payload: options.payload,
			}),
		)
		: false;
	if (didCreateRun) await safeRegistry('recordRunStart', () =>
		options.runRegistry?.recordRunStart({
			runId: options.runId,
			agentName: options.agentName,
			instanceId: options.id,
			startedAt,
		}),
	);
	return { ...options, ctx, startedAt, startedAtMs };
}

/**
 * Wrap all invocation modes with the same run-start/run-end envelope.
 */
async function withRunLifecycle<T>(
	lifecycle: RunLifecycle,
	body: () => T | Promise<T>,
): Promise<T> {
	const flushFanout = subscribeRunFanout(lifecycle);
	emitRunStart(lifecycle);
	try {
		const result = await body();
		await flushFanout();
		await emitRunEnd(lifecycle, { result, isError: false });
		return result;
	} catch (error) {
		await flushFanout();
		await emitRunEnd(lifecycle, { isError: true, error });
		throw error;
	}
}

function emitRunStart(lifecycle: RunLifecycle): void {
	lifecycle.ctx.emitEvent({
		type: 'run_start',
		runId: lifecycle.runId,
		instanceId: lifecycle.id,
		agentName: lifecycle.agentName,
		startedAt: lifecycle.startedAt,
		payload: lifecycle.payload,
	});
}

/**
 * Emit `run_end` and finalize the run.
 *
 * Terminal ordering matters for `/runs/:runId/stream`: append `run_end`
 * before marking the run terminal, then publish and close subscribers.
 */
async function emitRunEnd(
	lifecycle: RunLifecycle,
	input: { result?: unknown; isError: false } | { isError: true; error: unknown },
): Promise<void> {
	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const durationMs = endedAtMs - lifecycle.startedAtMs;
	const result = input.isError ? undefined : input.result;
	const error = input.isError ? serializeError(input.error) : undefined;
	const normalizedResult = result === undefined ? null : result;

	const { runStore, runSubscribers, runRegistry, runId } = lifecycle;

	// Decorate through the shared event path so eventIndex/timestamp stay continuous.
	const decorated = lifecycle.ctx.emitEvent({
		type: 'run_end',
		runId,
		result: normalizedResult,
		isError: input.isError,
		error,
		durationMs,
	});

	await safeRunStore('appendEvent(run_end)', () => runStore?.appendEvent(runId, decorated));

	runSubscribers?.publish(runId, decorated);

	const didEndRun = runStore
		? await safeRunStore('endRun', () =>
			runStore.endRun({
				runId,
				endedAt,
				isError: input.isError,
				durationMs,
				result,
				error,
			}),
		)
		: false;

	if (didEndRun) await safeRegistry('recordRunEnd', () =>
		runRegistry?.recordRunEnd({
			runId,
			endedAt,
			durationMs,
			isError: input.isError,
		}),
	);

	runSubscribers?.complete(runId);
}

/**
 * Persist non-terminal events before publishing them to live subscribers.
 * `run_end` is handled separately by {@link emitRunEnd}.
 */
function subscribeRunFanout(lifecycle: RunLifecycle): () => Promise<void> {
	const { ctx, runStore, runSubscribers, runId } = lifecycle;
	if (!runStore && !runSubscribers) return async () => {};
	let chain: Promise<void> = Promise.resolve();
	const unsubscribe = ctx.subscribeEvent((event) => {
		if (event.type === 'run_end') return;
		chain = chain.then(() => fanOutEvent(runStore, runSubscribers, runId, event));
	});
	return () => {
		unsubscribe();
		return chain;
	};
}

async function fanOutEvent(
	runStore: RunStore | undefined,
	runSubscribers: RunSubscriberRegistry | undefined,
	runId: string,
	event: FlueEvent,
): Promise<void> {
	if (runStore) {
		try {
			await runStore.appendEvent(runId, event);
		} catch (error) {
			console.error('[flue:run-store] appendEvent failed:', error);
		}
	}
	runSubscribers?.publish(runId, event);
}

async function safeRunStore(label: string, fn: () => Promise<void> | undefined): Promise<boolean> {
	try {
		await fn();
		return true;
	} catch (error) {
		console.error(`[flue:run-store] ${label} failed:`, error);
		return false;
	}
}

async function safeRegistry(label: string, fn: () => Promise<void> | undefined): Promise<void> {
	try {
		await fn();
	} catch (error) {
		console.error(`[flue:run-registry] ${label} failed:`, error);
	}
}

function serializeError(error: unknown): unknown {
	if (error instanceof Error) {
		return { name: error.name, message: error.message };
	}
	return error;
}

function getEventIndex(data: unknown): number | undefined {
	if (typeof data !== 'object' || data === null) return undefined;
	const value = (data as { eventIndex?: unknown }).eventIndex;
	return typeof value === 'number' ? value : undefined;
}

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Default webhook runner: invoke `run()` directly so the handler executes
 * in the current process. Used by the Node target. The Cloudflare target
 * overrides this with a `runFiber` wrapper for crash-recoverable execution
 * across DO hibernation.
 */
const defaultStartWebhook: StartWebhookFn = (_runId, run) => run();

/**
 * Default foreground handler runner: invoke directly. Used by the Node
 * target. The Cloudflare target overrides this with a `keepAliveWhile`
 * wrapper.
 */
const defaultRunHandler: RunHandlerFn = (ctx, handler) => handler(ctx);
