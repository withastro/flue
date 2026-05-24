/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import type { FlueContextInternal } from '../client.ts';
import { InvalidRequestError, parseJsonBody, RunEventTooLargeError, toHttpResponse } from '../errors.ts';
import type { CreatedAgent, DirectAgentPayload, DispatchReceipt, FlueEvent, FlueEventCallback } from '../types.ts';
import type { DispatchInput, DispatchProcessor } from './dispatch-queue.ts';
import { generateWorkflowRunId } from './ids.ts';
import type { RunOwner, RunRegistry } from './run-registry.ts';
import type { RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

/** Direct agent handler signature used by HTTP sync/webhook/SSE modes. */
export type AgentHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;
export type CreatedAgentHandler = CreatedAgent;
export type WorkflowHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

interface DirectRequestSession {
	processDirectInput(input: { message: string }): PromiseLike<unknown>;
}

interface DispatchSession {
	processDispatchInput(input: DispatchInput): PromiseLike<unknown>;
}

export interface AgentSessionTarget {
	agentName: string;
	instanceId: string;
}

export function createAgentDispatchProcessor(options: {
	agents: Record<string, CreatedAgentHandler>;
	createContext: CreateContextFn;
}): DispatchProcessor {
	return {
		async process(input) {
			const agent = options.agents[input.targetAgent];
			if (!agent) throw new Error(`[flue] dispatch target agent "${input.targetAgent}" has no created agent.`);
			const ctx = options.createContext(input.id, undefined, input, dispatchRequest());
			await createDispatchAgentHandler(agent, input)(ctx);
		},
	};
}

export interface PersistAgentDispatchAdmissionOptions {
	input: DispatchInput;
	createContext: CreateContextFn;
}

export async function persistAgentDispatchAdmission(options: PersistAgentDispatchAdmissionOptions): Promise<DispatchReceipt> {
	const { input } = options;
	if (!isDispatchInput(input)) throw new Error('[flue] Internal dispatch admission received an invalid payload.');
	return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
}

export function createDispatchAgentHandler(agent: CreatedAgentHandler, input: DispatchInput): AgentHandler {
	return (ctx) => processAgentDispatch(ctx, agent, input);
}

export async function reserveDispatchAgentSession(
	target: AgentSessionTarget,
	payload: unknown,
): Promise<() => void> {
	return waitForAgentSessionLock(target, payload);
}

async function processAgentDispatch(ctx: FlueContextInternal, agent: CreatedAgentHandler, input: DispatchInput): Promise<unknown> {
	const harness = await ctx.initializeCreatedAgent(agent, undefined);
	const session = await harness.session(input.session);
	if (!isDispatchSession(session)) {
		throw new Error('[flue] Internal session does not support dispatch input processing.');
	}
	return session.processDispatchInput(input);
}

function isDispatchInput(value: unknown): value is DispatchInput {
	if (!value || typeof value !== 'object') return false;
	const input = value as Partial<DispatchInput>;
	return typeof input.dispatchId === 'string' && input.dispatchId.trim() !== ''
		&& typeof input.targetAgent === 'string' && input.targetAgent.trim() !== ''
		&& input.agent === input.targetAgent
		&& typeof input.id === 'string' && input.id.trim() !== ''
		&& typeof input.session === 'string' && input.session.trim() !== ''
		&& input.input !== undefined
		&& typeof input.acceptedAt === 'string' && input.acceptedAt.trim() !== '';
}

function dispatchRequest(): Request {
	return new Request('http://flue.local/_dispatch', { method: 'POST' });
}

function isDispatchSession(value: unknown): value is DispatchSession {
	return !!value && typeof value === 'object' && typeof (value as DispatchSession).processDispatchInput === 'function';
}

export function createDirectAgentHandler(agent: CreatedAgentHandler): AgentHandler {
	return async (ctx) => {
		const payload = parseDirectAgentPayload(ctx.payload);
		const harness = await ctx.initializeCreatedAgent(agent, undefined);
		const session = await harness.session(payload.session);
		if (!isDirectRequestSession(session)) {
			throw new Error('[flue] Internal session does not support direct input processing.');
		}
		return session.processDirectInput({ message: payload.message });
	};
}

function isDirectRequestSession(value: unknown): value is DirectRequestSession {
	return !!value && typeof value === 'object' && typeof (value as DirectRequestSession).processDirectInput === 'function';
}

function parseDirectAgentPayload(payload: unknown): DirectAgentPayload {
	const expected = 'Direct agent requests must use JSON object body { "message": string, "session"?: string }.';
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new InvalidRequestError({ reason: expected });
	}
	const value = payload as { message?: unknown; session?: unknown };
	if (typeof value.message !== 'string') {
		throw new InvalidRequestError({ reason: expected });
	}
	if (value.session !== undefined && (typeof value.session !== 'string' || value.session.trim() === '')) {
		throw new InvalidRequestError({ reason: 'Direct agent request "session" must be a non-empty string when provided.' });
	}
	return { message: value.message, session: value.session };
}

/**
 * Caller-provided context factory. Differs per-target:
 *   - Node: env=process.env, defaultStore=in-memory, no resolveSandbox.
 *   - Cloudflare: env=DO env, defaultStore=DO SQLite, resolveSandbox=cfSandboxToSessionEnv.
 */
export type CreateContextFn = (
	id: string,
	runId: string | undefined,
	payload: unknown,
	request: Request,
	initialEventIndex?: number,
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
	handler: AgentHandler | WorkflowHandler,
) => unknown | Promise<unknown>;

export interface HandleAgentOptions {
	request: Request;
	agentName: string;
	id: string;
	handler: AgentHandler;
	createContext: CreateContextFn;
	runHandler?: RunHandlerFn;
}

export interface HandleWorkflowOptions {
	request: Request;
	workflowName: string;
	handler: WorkflowHandler;
	createContext: CreateContextFn;
	startWebhook?: StartWebhookFn;
	runHandler?: RunHandlerFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	runId?: string;
	restartedFromRunId?: string;
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
	const { request, agentName, id, handler, createContext } = opts;
	const runHandler = opts.runHandler ?? defaultRunHandler;

	try {
		const payload = await parseJsonBody(request);
		if (request.headers.get('x-webhook') === 'true') {
			throw new InvalidRequestError({ reason: 'Direct agent prompts are attached interactions. Use dispatch(...) for asynchronous delivery.' });
		}
		const directOptions: DirectAttachedOptions = {
			agentName,
			id,
			handler,
			payload,
			request,
			createContext,
			runHandler,
		};
		if ((request.headers.get('accept') || '').includes('text/event-stream')) {
			return runDirectSseMode(directOptions);
		}
		return runDirectSyncMode(directOptions);
	} catch (err) {
		return toHttpResponse(err);
	}
}

export async function handleWorkflowRequest(opts: HandleWorkflowOptions): Promise<Response> {
	const { request, workflowName, handler, createContext, runStore, runSubscribers, runRegistry, restartedFromRunId } = opts;
	const startWebhook = opts.startWebhook ?? defaultStartWebhook;
	const runHandler = opts.runHandler ?? defaultRunHandler;
	const runId = opts.runId ?? generateWorkflowRunId(workflowName);
	// Workflows have one instance per run, so the workflow instance id and
	// the run id are the same value. The owner shape mirrors agents so
	// per-workflow Durable Object classes route by `instanceId` like agent
	// DOs do.
	const instanceId = runId;

	try {
		const payload = await parseJsonBody(request);
		const accept = request.headers.get('accept') || '';
		const isSSE = accept.includes('text/event-stream');
		const wait = new URL(request.url).searchParams.get('wait');
		const owner = { kind: 'workflow' as const, workflowName, instanceId };

		if (wait === 'result') {
			return await runSyncMode({
				label: workflowName,
				owner,
				id: runId,
				runId,
				handler,
				payload,
				request,
				createContext,
				runHandler,
				runStore,
				runSubscribers,
				runRegistry,
				restartedFromRunId,
			});
		}

		if (isSSE) {
			return runSseMode({
				label: workflowName,
				owner,
				id: runId,
				runId,
				handler,
				payload,
				request,
				createContext,
				runHandler,
				runStore,
				runSubscribers,
				runRegistry,
				restartedFromRunId,
			});
		}

		return runWebhookMode({
			label: workflowName,
			owner,
			id: runId,
			runId,
			handler,
			payload,
			request,
			createContext,
			startWebhook,
			runStore,
			runSubscribers,
			runRegistry,
			restartedFromRunId,
		});
	} catch (err) {
		const response = toHttpResponse(err);
		response.headers.set('X-Flue-Run-Id', runId);
		return response;
	}
}

// ─── Mode implementations ───────────────────────────────────────────────────

interface ModeOptions {
	label: string;
	owner: RunOwner;
	id: string;
	runId: string;
	handler: WorkflowHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runHandler: RunHandlerFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	restartedFromRunId?: string;
}

export interface InvokeAttachedOptions {
	owner: RunOwner;
	id: string;
	runId: string;
	handler: WorkflowHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runHandler?: RunHandlerFn;
	onEvent?: FlueEventCallback;
	emitIdleOnComplete?: boolean;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	restartedFromRunId?: string;
}

export interface DirectAttachedOptions {
	agentName: string;
	id: string;
	handler: AgentHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runHandler?: RunHandlerFn;
	onEvent?: FlueEventCallback;
	emitIdleOnComplete?: boolean;
}

export interface AttachedInvocationResult {
	runId: string;
	result: unknown;
}

export interface RecoverRunOptions {
	label: string;
	owner: RunOwner;
	id: string;
	runId: string;
	handler: WorkflowHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

export interface FailRecoveredRunOptions extends Omit<RecoverRunOptions, 'handler'> {
	error: unknown;
	restartedAsRunId?: string;
}

export interface RecoveredRunResult {
	result?: unknown;
	isError: boolean;
	error?: unknown;
}

const activeAttachedAgentSessions = new Map<string, symbol>();

async function waitForAgentSessionLock(target: AgentSessionTarget, payload: unknown): Promise<() => void> {
	while (true) {
		try {
			return acquireDirectAgentSessionLock(target.agentName, target.instanceId, payload) ?? (() => {});
		} catch (error) {
			if (!(error instanceof InvalidRequestError) || error.details !== 'This agent session already has an active prompt.') throw error;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
	}
}

interface WebhookOptions {
	label: string;
	owner: RunOwner;
	id: string;
	runId: string;
	handler: WorkflowHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWebhook: StartWebhookFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	restartedFromRunId?: string;
}

async function runWebhookMode(opts: WebhookOptions): Promise<Response> {
	const {
		label,
		owner,
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
		restartedFromRunId,
	} = opts;

	// Webhook mode relies on `startWebhook` for target-specific execution
	// context (`runFiber` on Cloudflare), so it does not also use `runHandler`.
	const lifecycle = await createRunLifecycle({
		owner,
		id,
		runId,
		payload,
		request,
		createContext,
		runStore,
		runSubscribers,
		runRegistry,
		restartedFromRunId,
	});
	const { ctx } = lifecycle;
	let didRun = false;
	const run = async (): Promise<unknown> => {
		didRun = true;
		return withRunLifecycle(lifecycle, () => handler(ctx));
	};

	try {
		const scheduled = startWebhook(runId, run);
		scheduled.then(
			(result) => {
				console.log(
					'[flue] Webhook handler complete:',
					label,
					result !== undefined ? JSON.stringify(result) : '(no return)',
				);
			},
			async (err) => {
				console.error('[flue] Webhook handler error:', label, err);
				if (!didRun) await emitRunEnd(lifecycle, { isError: true, error: err });
			},
		);
	} catch (error) {
		await emitRunEnd(lifecycle, { isError: true, error });
		throw error;
	}

	return new Response(JSON.stringify({ status: 'accepted', runId }), {
		status: 202,
		headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': runId },
	});
}

export async function failRecoveredRun(opts: FailRecoveredRunOptions): Promise<void> {
	const events = opts.runStore ? await opts.runStore.getEvents(opts.runId) : [];
	const terminalEvent = findTerminalRunEvent(events);
	const run = await opts.runStore?.getRun(opts.runId);
	if (terminalEvent || (run && run.status !== 'active')) {
		await reconcileTerminalRun(opts, run, terminalEvent, events);
		return;
	}
	if (run) await safeRegistry('recordRunStart(recovery)', () => opts.runRegistry?.recordRunStart({
		runId: opts.runId,
		owner: run.owner,
		startedAt: run.startedAt,
	}));
	const initialEventIndex = nextEventIndex(events);
	const startedAt = run?.startedAt ?? new Date().toISOString();
	const startedAtMs = Date.parse(startedAt);
	const lifecycle: RunLifecycle = {
		...opts,
		ctx: opts.createContext(opts.id, opts.runId, opts.payload, opts.request, initialEventIndex),
		startedAt,
		startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
	};
	await emitRunEnd(lifecycle, { isError: true, error: opts.error });
}

export async function recoverWorkflowRun(opts: RecoverRunOptions): Promise<RecoveredRunResult> {
	try {
		const events = opts.runStore ? await opts.runStore.getEvents(opts.runId) : [];
		const terminalEvent = findTerminalRunEvent(events);
		const run = await opts.runStore?.getRun(opts.runId);
		if (terminalEvent || (run && run.status !== 'active')) {
			return reconcileTerminalRun(opts, run, terminalEvent, events);
		}
		if (run) await safeRegistry('recordRunStart(recovery)', () => opts.runRegistry?.recordRunStart({
			runId: opts.runId,
			owner: run.owner,
			startedAt: run.startedAt,
		}));
		const initialEventIndex = nextEventIndex(events);
		const startedAt = run?.startedAt ?? new Date().toISOString();
		const startedAtMs = Date.parse(startedAt);
		const lifecycle: RunLifecycle = {
			...opts,
			ctx: opts.createContext(opts.id, opts.runId, opts.payload, opts.request, initialEventIndex),
			startedAt,
			startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
		};
		const result = await invokeRunLifecycle(lifecycle, () => opts.handler(lifecycle.ctx), !events.some((event) => event.type === 'run_start'));
		return { result, isError: false };
	} catch (error) {
		try {
			await failRecoveredRun({ ...opts, error });
		} catch (terminalizationError) {
			console.error('[flue] Failed to persist recovered run error event:', terminalizationError);
			const endedAt = new Date().toISOString();
			await safeRunStore('endRun(recovery-fallback)', () => opts.runStore?.endRun({
				runId: opts.runId,
				endedAt,
				isError: true,
				durationMs: 0,
				error: serializeError(error),
			}));
			await safeRegistry('recordRunStart(recovery-fallback)', () => opts.runRegistry?.recordRunStart({
				runId: opts.runId,
				owner: opts.owner,
				startedAt: endedAt,
			}));
			await safeRegistry('recordRunEnd(recovery-fallback)', () => opts.runRegistry?.recordRunEnd({
				runId: opts.runId,
				endedAt,
				durationMs: 0,
				isError: true,
			}));
			throw terminalizationError;
		}
		return { isError: true, error };
	}
}

async function reconcileTerminalRun(
	opts: Omit<RecoverRunOptions, 'handler'>,
	run: Awaited<ReturnType<RunStore['getRun']>> | undefined,
	terminalEvent: Extract<FlueEvent, { type: 'run_end' }> | undefined,
	events: FlueEvent[],
): Promise<RecoveredRunResult> {
	const isError = terminalEvent?.isError ?? run?.isError ?? false;
	const result = terminalEvent?.result ?? run?.result;
	const error = terminalEvent?.error ?? run?.error;
	const endedAt = terminalEvent?.timestamp ?? run?.endedAt ?? new Date().toISOString();
	const durationMs = terminalEvent?.durationMs ?? run?.durationMs ?? 0;
	if (!terminalEvent && run && run.status !== 'active') {
		try {
			await opts.runStore?.appendEvent(opts.runId, {
				type: 'run_end',
				runId: opts.runId,
				result: result === undefined ? null : result,
				isError,
				error,
				durationMs,
				eventIndex: nextEventIndex(events),
				timestamp: endedAt,
			});
		} catch (eventError) {
			console.error('[flue:run-store] appendEvent(run_end recovery) failed:', eventError);
		}
	}
	if (terminalEvent && (!run || run.status === 'active')) {
		await opts.runStore?.endRun({
			runId: opts.runId,
			endedAt,
			isError,
			durationMs,
			result,
			error,
		});
	}
	await safeRegistry('recordRunStart(recovery)', () => opts.runRegistry?.recordRunStart({
		runId: opts.runId,
		owner: run?.owner ?? opts.owner,
		startedAt: run?.startedAt ?? endedAt,
	}));
	await safeRegistry('recordRunEnd(recovery)', () => opts.runRegistry?.recordRunEnd({
		runId: opts.runId,
		endedAt,
		durationMs,
		isError,
	}));
	opts.runSubscribers?.complete(opts.runId);
	return { result, isError, error };
}

function findTerminalRunEvent(events: FlueEvent[]): Extract<FlueEvent, { type: 'run_end' }> | undefined {
	return [...events].reverse().find(
		(event): event is Extract<FlueEvent, { type: 'run_end' }> => event.type === 'run_end',
	);
}

function nextEventIndex(events: FlueEvent[]): number {
	return events.reduce((next, event) => Math.max(next, (event.eventIndex ?? -1) + 1), 0);
}

/**
 * Shared heartbeat interval for SSE streams.
 */
export const SSE_HEARTBEAT_MS = 15_000;

function runDirectSseMode(opts: DirectAttachedOptions): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	let closed = false;
	const writeSSE = async (data: unknown, eventType: string): Promise<void> => {
		if (closed) return;
		const eventIndex = getEventIndex(data) ?? 0;
		const lines = [`event: ${eventType}`, `id: ${eventIndex}`, `data: ${typeof data === 'string' ? data : JSON.stringify(data)}`, '', ''];
		try {
			await writer.write(encoder.encode(lines.join('\n')));
		} catch {}
	};
	const heartbeat = setInterval(() => {
		if (!closed) writer.write(encoder.encode(': heartbeat\n\n')).catch(() => {});
	}, SSE_HEARTBEAT_MS);
	(async () => {
		try {
			await invokeDirectAttached({ ...opts, onEvent: (event) => writeSSE(event, event.type), emitIdleOnComplete: true });
		} catch (error) {
			await writeSSE({ message: error instanceof Error ? error.message : String(error) }, 'error');
		} finally {
			clearInterval(heartbeat);
			closed = true;
			try {
				await writer.close();
			} catch {}
		}
	})();
	return new Response(readable, {
		headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' },
	});
}

async function runDirectSyncMode(opts: DirectAttachedOptions): Promise<Response> {
	const result = await invokeDirectAttached(opts);
	return new Response(JSON.stringify({ result: result === undefined ? null : result }), {
		headers: { 'content-type': 'application/json' },
	});
}

export async function invokeDirectAttached(opts: DirectAttachedOptions): Promise<unknown> {
	const sessionLock = acquireDirectAgentSessionLock(opts.agentName, opts.id, opts.payload);
	try {
		const ctx = opts.createContext(opts.id, undefined, opts.payload, opts.request);
		const runHandler = opts.runHandler ?? defaultRunHandler;
		let didEmitIdle = false;
		if (opts.onEvent || opts.emitIdleOnComplete) {
			ctx.setEventCallback((event) => {
				if (event.type === 'idle') didEmitIdle = true;
				return opts.onEvent?.(event);
			});
		}
		try {
			return await runHandler(ctx, async (innerCtx) => {
				try {
					return await opts.handler(innerCtx);
				} finally {
					if (opts.emitIdleOnComplete && !didEmitIdle) innerCtx.emitEvent({ type: 'idle' });
				}
			});
		} finally {
			ctx.setEventCallback(undefined);
		}
	} finally {
		sessionLock?.();
	}
}

function runSseMode(opts: ModeOptions): Response {
	const { runId } = opts;

	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
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
		try {
			await invokeAttached({
				...opts,
				onEvent: (event) => writeSSE(event, event.type),
				emitIdleOnComplete: true,
			});
		} catch (error) {
			await writeSSE({ message: error instanceof Error ? error.message : String(error) }, 'error');
		} finally {
			clearInterval(heartbeat);
			closed = true;
			try {
				await writer.close();
			} catch {
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
	const invocation = await invokeAttached(opts);
	return new Response(
		JSON.stringify({ result: invocation.result === undefined ? null : invocation.result, _meta: { runId: invocation.runId } }),
		{ headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': invocation.runId } },
	);
}

export async function invokeAttached(opts: InvokeAttachedOptions): Promise<AttachedInvocationResult> {
	return invokeAttachedUnlocked(opts);
}

async function invokeAttachedUnlocked(opts: InvokeAttachedOptions): Promise<AttachedInvocationResult> {
	const lifecycle = await createRunLifecycle({
		owner: opts.owner,
		id: opts.id,
		runId: opts.runId,
		payload: opts.payload,
		request: opts.request,
		createContext: opts.createContext,
		runStore: opts.runStore,
		runSubscribers: opts.runSubscribers,
		runRegistry: opts.runRegistry,
		restartedFromRunId: opts.restartedFromRunId,
	});
	const { ctx } = lifecycle;
	const runHandler = opts.runHandler ?? defaultRunHandler;
	let didEmitIdle = false;
	if (opts.onEvent || opts.emitIdleOnComplete) {
		ctx.setEventCallback((event) => {
			if (event.type === 'idle') didEmitIdle = true;
			return opts.onEvent?.(event);
		});
	}
	try {
		const result = await withRunLifecycle(lifecycle, async () => {
			try {
				return await runHandler(ctx, opts.handler);
			} finally {
				if (opts.emitIdleOnComplete && !didEmitIdle) ctx.emitEvent({ type: 'idle' });
			}
		});
		return { runId: opts.runId, result };
	} finally {
		ctx.setEventCallback(undefined);
	}
}

function acquireDirectAgentSessionLock(agentName: string, instanceId: string, input: unknown): (() => void) | undefined {
	const payload = input as { session?: unknown } | null;
	const session = typeof payload?.session === 'string' && payload.session.trim() !== '' ? payload.session : 'default';
	const key = `${agentName}\0${instanceId}\0${session}`;
	if (activeAttachedAgentSessions.has(key)) {
		throw new InvalidRequestError({ reason: 'This agent session already has an active prompt.' });
	}
	const token = Symbol(key);
	activeAttachedAgentSessions.set(key, token);
	return () => {
		if (activeAttachedAgentSessions.get(key) === token) activeAttachedAgentSessions.delete(key);
	};
}

// ─── Run lifecycle ──────────────────────────────────────────────────────────

interface RunLifecycleOptions {
	owner: RunOwner;
	id: string;
	runId: string;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	restartedFromRunId?: string;
	restartedAsRunId?: string;
	requireDurableAdmission?: boolean;
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
	const owner = options.owner;
	if (options.requireDurableAdmission && !runStore) {
		throw new Error('[flue] Durable dispatch admission requires a target Durable Object run store.');
	}
	const didCreateRun = runStore
		? await persistRunAdmission('createRun', options.requireDurableAdmission === true, () =>
			runStore.createRun({
				runId: options.runId,
				owner,
				startedAt,
				payload: options.payload,
				restartedFromRunId: options.restartedFromRunId,
			}),
		)
		: false;
	if (didCreateRun) await safeRegistry('recordRunStart', () =>
		options.runRegistry?.recordRunStart({
			runId: options.runId,
			owner,
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
	return invokeRunLifecycle(lifecycle, body, true);
}

async function invokeRunLifecycle<T>(
	lifecycle: RunLifecycle,
	body: () => T | Promise<T>,
	emitStart: boolean,
): Promise<T> {
	const flushFanout = subscribeRunFanout(lifecycle);
	if (emitStart) emitRunStart(lifecycle);
	let didFlushFanout = false;
	let result: T;
	try {
		result = await body();
		await flushFanout();
		didFlushFanout = true;
	} catch (error) {
		if (!didFlushFanout) {
			try {
				await flushFanout();
			} catch {}
		}
		await emitRunEnd(lifecycle, { isError: true, error });
		throw error;
	}
	await emitRunEnd(lifecycle, { result, isError: false });
	return result;
}

function emitRunStart(lifecycle: RunLifecycle): void {
	lifecycle.ctx.emitEvent({
		type: 'run_start',
		runId: lifecycle.runId,
		owner: lifecycle.owner,
		instanceId: lifecycle.owner.instanceId,
		workflowName: lifecycle.owner.workflowName,
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

	let appendError: unknown;
	try {
		await persistRunEvent('appendEvent(run_end)', () => runStore?.appendEvent(runId, decorated));
	} catch (error) {
		appendError = error;
	}

	runSubscribers?.publish(runId, decorated);

	const didEndRun = runStore
		? await safeRunStore('endRun', () =>
			runStore.endRun({
				runId,
				restartedAsRunId: lifecycle.restartedAsRunId,
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
	if (appendError) throw appendError;
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
		await persistRunEvent('appendEvent', () => runStore.appendEvent(runId, event));
	}
	runSubscribers?.publish(runId, event);
}

async function persistRunEvent(label: string, fn: () => Promise<void> | undefined): Promise<boolean> {
	try {
		await fn();
		return true;
	} catch (error) {
		if (error instanceof RunEventTooLargeError) throw error;
		console.error(`[flue:run-store] ${label} failed:`, error);
		return false;
	}
}

async function persistRunAdmission(label: string, required: boolean, fn: () => Promise<void> | undefined): Promise<boolean> {
	try {
		await fn();
		return true;
	} catch (error) {
		console.error(`[flue:run-store] ${label} failed:`, error);
		if (required) throw error;
		return false;
	}
}

async function safeRunStore(label: string, fn: () => Promise<void> | undefined): Promise<boolean> {
	return persistRunAdmission(label, false, fn);
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
const defaultStartWebhook: StartWebhookFn = (_runId, run) => Promise.resolve().then(run);

/**
 * Default foreground handler runner: invoke directly. Used by the Node
 * target. The Cloudflare target overrides this with a `keepAliveWhile`
 * wrapper.
 */
const defaultRunHandler: RunHandlerFn = (ctx, handler) => handler(ctx);
