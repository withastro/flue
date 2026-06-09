/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import type { FlueContextInternal } from '../client.ts';
import {
	InvalidRequestError,
	parseJsonBody,
	RunEventTooLargeError,
	RunStoreUnavailableError,
	toHttpResponse,
	toPublicError,
} from '../errors.ts';
import { isTaskSessionName } from '../session-identity.ts';
import type {
	AttachedAgentEventCallback,
	CreatedAgent,
	DirectAgentPayload,
	FlueEvent,
	FlueEventCallback,
} from '../types.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import { streamActiveRunEvents } from './handle-run-routes.ts';
import { generateWorkflowRunId } from './ids.ts';
import type { RunOwner, RunRegistry } from './run-registry.ts';
import { assertPersistedWorkflowEvent, isEphemeralRunEvent, type RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

/** Direct agent handler signature used by attached HTTP and WebSocket prompts. */
export type AgentHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;
export type WorkflowHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

interface DirectRequestSession {
	processDirectInput(input: { message: string }): PromiseLike<unknown>;
}

export function assertAgentDispatchAdmissionInput(input: unknown): asserts input is DispatchInput {
	if (!isDispatchInput(input))
		throw new Error('[flue] Internal dispatch admission received an invalid payload.');
	if (isTaskSessionName(input.session)) {
		throw new Error(
			'[flue] Internal dispatch admission session names beginning with "task:" are reserved for delegated tasks.',
		);
	}
}

function isDispatchInput(value: unknown): value is DispatchInput {
	if (!value || typeof value !== 'object') return false;
	const input = value as Partial<DispatchInput>;
	return (
		typeof input.dispatchId === 'string' &&
		input.dispatchId.trim() !== '' &&
		typeof input.agent === 'string' &&
		input.agent.trim() !== '' &&
		typeof input.id === 'string' &&
		input.id.trim() !== '' &&
		typeof input.session === 'string' &&
		input.session.trim() !== '' &&
		input.input !== undefined &&
		typeof input.acceptedAt === 'string' &&
		input.acceptedAt.trim() !== ''
	);
}

export function createDirectAgentHandler(agent: CreatedAgent): AgentHandler {
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
	return (
		!!value &&
		typeof value === 'object' &&
		typeof (value as DirectRequestSession).processDirectInput === 'function'
	);
}

function parseDirectAgentPayload(payload: unknown): DirectAgentPayload {
	const expected =
		'Direct agent requests must use JSON object body { "message": string, "session"?: string }.';
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new InvalidRequestError({ reason: expected });
	}
	const value = payload as { message?: unknown; session?: unknown };
	if (typeof value.message !== 'string') {
		throw new InvalidRequestError({ reason: expected });
	}
	if (
		value.session !== undefined &&
		(typeof value.session !== 'string' || value.session.trim() === '')
	) {
		throw new InvalidRequestError({
			reason: 'Direct agent request "session" must be a non-empty string when provided.',
		});
	}
	if (typeof value.session === 'string' && isTaskSessionName(value.session)) {
		throw new InvalidRequestError({
			reason:
				'Direct agent request "session" names beginning with "task:" are reserved for delegated tasks.',
		});
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
	dispatchId?: string,
) => FlueContextInternal;

/**
 * Background workflow admission wrapper. Receives the prepared workflow-run
 * callback and returns a promise that resolves with its result. Implementations:
 *
 *   - Node: just `run()` — no fiber, no DO.
 *   - Cloudflare: `doInstance.runFiber('flue:workflow:<runId>', run)`.
 *
 * The caller is responsible for any logging on completion/error; this wrapper
 * starts durably admitted workflow execution for any supported observation mode.
 */
export type StartWorkflowAdmissionFn = (
	runId: string,
	run: () => Promise<unknown>,
) => Promise<unknown>;

/**
 * Direct-agent foreground execution wrapper. Wraps the call to `handler(ctx)`
 * so targets can layer in keepalive / context propagation. Defaults to direct
 * invocation when omitted.
 */
export interface HandleAgentOptions {
	request: Request;
	id: string;
	admitAttachedSubmission: AttachedAgentSubmissionAdmission;
}

export interface HandleWorkflowOptions {
	request: Request;
	workflowName: string;
	handler: WorkflowHandler;
	createContext: CreateContextFn;
	startWorkflowAdmission?: StartWorkflowAdmissionFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	runId?: string;
}

/**
 * Handle one attached `/agents/:name/:id` prompt interaction.
 *
 * `Accept: text/event-stream` returns attached event streaming; otherwise the
 * response is synchronous JSON `{ result }`. Former `X-Webhook: true` agent
 * requests are rejected because asynchronous delivery uses `dispatch(...)`.
 *
 * Errors thrown before streaming starts are returned as regular HTTP error
 * responses; errors thrown after SSE begins are framed as stream errors.
 */
export async function handleAgentRequest(opts: HandleAgentOptions): Promise<Response> {
	const { request, id } = opts;

	try {
		const rawPayload = await parseJsonBody(request);
		if (request.headers.get('x-webhook') === 'true') {
			throw new InvalidRequestError({
				reason:
					'Direct agent prompts are attached interactions. Use dispatch(...) for asynchronous delivery.',
			});
		}
		const payload = parseDirectAgentPayload(rawPayload);
		const directOptions: DirectAttachedOptions = {
			id,
			payload,
			admitAttachedSubmission: opts.admitAttachedSubmission,
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
	const { request, workflowName, handler, createContext, runStore, runSubscribers, runRegistry } =
		opts;
	const startWorkflowAdmission = opts.startWorkflowAdmission ?? defaultStartWorkflowAdmission;
	const runId = opts.runId ?? generateWorkflowRunId(workflowName);
	const instanceId = runId;

	try {
		const payload = await parseJsonBody(request);
		const accept = request.headers.get('accept') || '';
		const isSSE = accept.includes('text/event-stream');
		const wait = new URL(request.url).searchParams.get('wait');
		const owner = { kind: 'workflow' as const, workflowName, instanceId };
		if (isSSE && wait !== 'result' && !runSubscribers)
			throw new Error('[flue] Workflow SSE requires a run subscriber registry.');

		const execution = await prepareWorkflowExecution({
			owner,
			id: runId,
			runId,
			handler,
			payload,
			request,
			createContext,
			startWorkflowAdmission,
			runStore,
			runSubscribers,
			runRegistry,
		});

		if (isSSE && wait !== 'result') return await runSseMode(execution);
		if (wait === 'result') return await runSyncMode(execution);
		return await runWorkflowAdmissionMode(execution);
	} catch (err) {
		const response = toHttpResponse(err);
		response.headers.set('X-Flue-Run-Id', runId);
		return response;
	}
}

// ─── Mode implementations ───────────────────────────────────────────────────

export interface InvokeWorkflowAttachedOptions {
	owner: RunOwner;
	id: string;
	runId: string;
	handler: WorkflowHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWorkflowAdmission?: StartWorkflowAdmissionFn;
	onAdmitted?: (runId: string) => void;
	onEvent?: FlueEventCallback;
	emitIdleOnComplete?: boolean;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

export interface DirectAttachedOptions {
	id: string;
	payload: DirectAgentPayload;
	admitAttachedSubmission: AttachedAgentSubmissionAdmission;
	onEvent?: AttachedAgentEventCallback;
	emitIdleOnComplete?: boolean;
}

export interface WorkflowAttachedInvocationResult {
	runId: string;
	result: unknown;
}

export interface FailRecoveredRunOptions {
	owner: RunOwner;
	id: string;
	runId: string;
	request: Request;
	createContext: CreateContextFn;
	error: unknown;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
}

interface WorkflowAdmissionOptions {
	owner: RunOwner;
	id: string;
	runId: string;
	handler: WorkflowHandler;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	startWorkflowAdmission: StartWorkflowAdmissionFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	onAdmitted?: (runId: string) => void;
	onEvent?: FlueEventCallback;
	emitIdleOnComplete?: boolean;
}

interface AdmittedWorkflowExecution {
	runId: string;
	runStore: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	lifecycle: WorkflowRunLifecycle;
	startWorkflowAdmission: StartWorkflowAdmissionFn;
	handler: WorkflowHandler;
	onAdmitted?: (runId: string) => void;
	onEvent?: FlueEventCallback;
	emitIdleOnComplete?: boolean;
	completion?: Promise<unknown>;
}

async function prepareWorkflowExecution(
	opts: WorkflowAdmissionOptions,
): Promise<AdmittedWorkflowExecution> {
	const {
		owner,
		id,
		runId,
		handler,
		payload,
		request,
		createContext,
		startWorkflowAdmission,
		runStore,
		runSubscribers,
		runRegistry,
		onAdmitted,
		onEvent,
		emitIdleOnComplete,
	} = opts;
	if (!runStore) throw new RunStoreUnavailableError();
	const lifecycle = await createWorkflowRunLifecycle({
		owner,
		id,
		runId,
		payload,
		request,
		createContext,
		runStore,
		runSubscribers,
		runRegistry,
		requirePersistedAdmission: true,
	});
	return {
		runId,
		runStore,
		runSubscribers,
		lifecycle,
		startWorkflowAdmission,
		handler,
		onAdmitted,
		onEvent,
		emitIdleOnComplete,
	};
}

function startWorkflowExecution(execution: AdmittedWorkflowExecution): Promise<unknown> {
	if (execution.completion) return execution.completion;
	const { runId, lifecycle, handler, startWorkflowAdmission, onEvent, emitIdleOnComplete } =
		execution;
	let didRun = false;
	let didEmitIdle = false;
	if (onEvent || emitIdleOnComplete) {
		lifecycle.ctx.setEventCallback((event) => {
			if (event.type === 'idle') didEmitIdle = true;
			return onEvent?.(event);
		});
	}
	const run = async (): Promise<unknown> => {
		didRun = true;
		try {
			return await withWorkflowRunLifecycle(lifecycle, async () => {
				execution.onAdmitted?.(runId);
				try {
					return await handler(lifecycle.ctx);
				} finally {
					if (emitIdleOnComplete && !didEmitIdle) lifecycle.ctx.emitEvent({ type: 'idle' });
				}
			});
		} finally {
			lifecycle.ctx.setEventCallback(undefined);
		}
	};
	let scheduled: Promise<unknown>;
	try {
		scheduled = startWorkflowAdmission(runId, run);
	} catch (error) {
		lifecycle.ctx.setEventCallback(undefined);
		execution.completion = emitRunEnd(lifecycle, { isError: true, error }).then(() =>
			Promise.reject(error),
		);
		execution.completion.catch(() => undefined);
		throw error;
	}
	execution.completion = scheduled.catch(async (error) => {
		if (!didRun) {
			await emitRunEnd(lifecycle, { isError: true, error });
			lifecycle.ctx.setEventCallback(undefined);
		}
		throw error;
	});
	return execution.completion;
}

async function runWorkflowAdmissionMode(execution: AdmittedWorkflowExecution): Promise<Response> {
	try {
		startWorkflowExecution(execution);
	} catch (error) {
		await execution.completion?.catch(() => undefined);
		throw error;
	}
	return new Response(JSON.stringify({ status: 'accepted', runId: execution.runId }), {
		status: 202,
		headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': execution.runId },
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
	if (run)
		await safeRegistry('recordRunStart(recovery)', () =>
			opts.runRegistry?.recordRunStart({
				runId: opts.runId,
				owner: run.owner,
				startedAt: run.startedAt,
			}),
		);
	const initialEventIndex = nextEventIndex(opts.runId, events);
	const startedAt = run?.startedAt ?? new Date().toISOString();
	const startedAtMs = Date.parse(startedAt);
	const startEvent = events.find((event) => event.type === 'run_start');
	const payload = run?.payload !== undefined ? run.payload : startEvent?.payload;
	const lifecycle: WorkflowRunLifecycle = {
		...opts,
		payload,
		ctx: opts.createContext(opts.id, opts.runId, payload, opts.request, initialEventIndex),
		startedAt,
		startedAtMs: Number.isFinite(startedAtMs) ? startedAtMs : Date.now(),
	};
	const flushFanout = subscribeRunFanout(lifecycle);
	emitRunResume(lifecycle);
	await flushFanout();
	await emitRunEnd(lifecycle, { isError: true, error: opts.error });
}

async function reconcileTerminalRun(
	opts: FailRecoveredRunOptions,
	run: Awaited<ReturnType<RunStore['getRun']>> | undefined,
	terminalEvent: Extract<FlueEvent, { type: 'run_end' }> | undefined,
	events: FlueEvent[],
): Promise<void> {
	const isError = terminalEvent?.isError ?? run?.isError ?? false;
	const result = terminalEvent?.result !== undefined ? terminalEvent.result : run?.result;
	const error = terminalEvent?.error !== undefined ? terminalEvent.error : run?.error;
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
				eventIndex: nextEventIndex(opts.runId, events),
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
	await safeRegistry('recordRunStart(recovery)', () =>
		opts.runRegistry?.recordRunStart({
			runId: opts.runId,
			owner: run?.owner ?? opts.owner,
			startedAt: run?.startedAt ?? endedAt,
		}),
	);
	await safeRegistry('recordRunEnd(recovery)', () =>
		opts.runRegistry?.recordRunEnd({
			runId: opts.runId,
			endedAt,
			durationMs,
			isError,
		}),
	);
	opts.runSubscribers?.complete(opts.runId);
}

function findTerminalRunEvent(
	events: FlueEvent[],
): Extract<FlueEvent, { type: 'run_end' }> | undefined {
	return [...events]
		.reverse()
		.find((event): event is Extract<FlueEvent, { type: 'run_end' }> => event.type === 'run_end');
}

function nextEventIndex(runId: string, events: FlueEvent[]): number {
	const next = events.reduce(
		(index, event) => Math.max(index, assertPersistedWorkflowEvent(runId, event) + 1),
		0,
	);
	if (!Number.isSafeInteger(next)) {
		throw new Error(
			'[flue:run-store] persisted workflow event index exhausted the safe integer range.',
		);
	}
	return next;
}

const SSE_HEARTBEAT_MS = 15_000;

function runDirectSseMode(opts: DirectAttachedOptions): Response {
	const { readable, writable } = new TransformStream();
	const writer = writable.getWriter();
	const encoder = new TextEncoder();
	let closed = false;
	const writeSSE = async (data: unknown, eventType: string): Promise<void> => {
		if (closed) return;
		const eventIndex = getEventIndex(data) ?? 0;
		const lines = [
			`event: ${eventType}`,
			`id: ${eventIndex}`,
			`data: ${typeof data === 'string' ? data : JSON.stringify(data)}`,
			'',
			'',
		];
		try {
			await writer.write(encoder.encode(lines.join('\n')));
		} catch {}
	};
	const heartbeat = setInterval(() => {
		if (!closed) writer.write(encoder.encode(': heartbeat\n\n')).catch(() => {});
	}, SSE_HEARTBEAT_MS);
	(async () => {
		try {
			await invokeDirectAttached({
				...opts,
				onEvent: (event) => writeSSE(event, event.type),
				emitIdleOnComplete: true,
			});
		} catch (error) {
			await writeSSE({ type: 'error', instanceId: opts.id, error: toPublicError(error) }, 'error');
		} finally {
			clearInterval(heartbeat);
			closed = true;
			try {
				await writer.close();
			} catch {}
		}
	})();
	return new Response(readable, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

async function runDirectSyncMode(opts: DirectAttachedOptions): Promise<Response> {
	const result = await invokeDirectAttached(opts);
	return new Response(JSON.stringify({ result: result === undefined ? null : result }), {
		headers: { 'content-type': 'application/json' },
	});
}

export async function invokeDirectAttached(opts: DirectAttachedOptions): Promise<unknown> {
	return opts.admitAttachedSubmission(opts.payload, opts.onEvent);
}

async function runSseMode(execution: AdmittedWorkflowExecution): Promise<Response> {
	if (!execution.runSubscribers)
		throw new Error('[flue] Workflow SSE requires a run subscriber registry.');
	const response = streamActiveRunEvents(
		execution.runStore,
		execution.runSubscribers,
		execution.runId,
	);
	response.headers.set('X-Flue-Run-Id', execution.runId);
	try {
		startWorkflowExecution(execution);
	} catch (error) {
		await execution.completion?.catch(() => undefined);
		await response.body?.cancel();
		throw error;
	}
	return response;
}

async function runSyncMode(execution: AdmittedWorkflowExecution): Promise<Response> {
	let result: unknown;
	try {
		result = await startWorkflowExecution(execution);
	} catch (error) {
		await execution.completion?.catch(() => undefined);
		throw error;
	}
	return new Response(
		JSON.stringify({
			result: result === undefined ? null : result,
			_meta: { runId: execution.runId },
		}),
		{ headers: { 'content-type': 'application/json', 'X-Flue-Run-Id': execution.runId } },
	);
}

export async function invokeWorkflowAttached(
	opts: InvokeWorkflowAttachedOptions,
): Promise<WorkflowAttachedInvocationResult> {
	if (!opts.startWorkflowAdmission) return invokeWorkflowAttachedUnlocked(opts);
	const execution = await prepareWorkflowExecution({
		owner: opts.owner,
		id: opts.id,
		runId: opts.runId,
		handler: opts.handler,
		payload: opts.payload,
		request: opts.request,
		createContext: opts.createContext,
		startWorkflowAdmission: opts.startWorkflowAdmission,
		runStore: opts.runStore,
		runSubscribers: opts.runSubscribers,
		runRegistry: opts.runRegistry,
		onAdmitted: opts.onAdmitted,
		onEvent: opts.onEvent,
		emitIdleOnComplete: opts.emitIdleOnComplete,
	});
	let result: unknown;
	try {
		result = await startWorkflowExecution(execution);
	} catch (error) {
		await execution.completion?.catch(() => undefined);
		throw error;
	}
	return { runId: opts.runId, result };
}

async function invokeWorkflowAttachedUnlocked(
	opts: InvokeWorkflowAttachedOptions,
): Promise<WorkflowAttachedInvocationResult> {
	const lifecycle = await createWorkflowRunLifecycle({
		owner: opts.owner,
		id: opts.id,
		runId: opts.runId,
		payload: opts.payload,
		request: opts.request,
		createContext: opts.createContext,
		runStore: opts.runStore,
		runSubscribers: opts.runSubscribers,
		runRegistry: opts.runRegistry,
	});
	const { ctx } = lifecycle;
	let didEmitIdle = false;
	if (opts.onEvent || opts.emitIdleOnComplete) {
		ctx.setEventCallback((event) => {
			if (event.type === 'idle') didEmitIdle = true;
			return opts.onEvent?.(event);
		});
	}
	try {
		const result = await withWorkflowRunLifecycle(lifecycle, async () => {
			try {
				return await opts.handler(ctx);
			} finally {
				if (opts.emitIdleOnComplete && !didEmitIdle) ctx.emitEvent({ type: 'idle' });
			}
		});
		return { runId: opts.runId, result };
	} finally {
		ctx.setEventCallback(undefined);
	}
}

// ─── Workflow run lifecycle ─────────────────────────────────────────────────

interface WorkflowRunLifecycleOptions {
	owner: RunOwner;
	id: string;
	runId: string;
	payload: unknown;
	request: Request;
	createContext: CreateContextFn;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	runRegistry?: RunRegistry;
	requirePersistedAdmission?: boolean;
}

interface WorkflowRunLifecycle extends WorkflowRunLifecycleOptions {
	ctx: FlueContextInternal;
	startedAt: string;
	startedAtMs: number;
}

async function createWorkflowRunLifecycle(
	options: WorkflowRunLifecycleOptions,
): Promise<WorkflowRunLifecycle> {
	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const ctx = options.createContext(options.id, options.runId, options.payload, options.request);
	const runStore = options.runStore;
	const owner = options.owner;
	let didCreateRun = false;
	try {
		didCreateRun = runStore
			? await persistRunAdmission('createRun', options.requirePersistedAdmission === true, () =>
					runStore.createRun({
						runId: options.runId,
						owner,
						startedAt,
						payload: options.payload,
					}),
				)
			: false;
	} catch (error) {
		console.error(
			'[flue] Workflow admission error:',
			{
				workflowName: owner.workflowName,
				runId: options.runId,
				operation: 'createRun',
				outcome: 'admission_failed',
			},
			error,
		);
		throw error;
	}
	if (didCreateRun)
		await safeRegistry('recordRunStart', () =>
			options.runRegistry?.recordRunStart({
				runId: options.runId,
				owner,
				startedAt,
			}),
		);
	return { ...options, ctx, startedAt, startedAtMs };
}

/**
 * Wrap all workflow invocation modes with the same run-start/run-end envelope.
 */
async function withWorkflowRunLifecycle<T>(
	lifecycle: WorkflowRunLifecycle,
	body: () => T | Promise<T>,
): Promise<T> {
	const flushFanout = subscribeRunFanout(lifecycle);
	emitRunStart(lifecycle);
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

function emitRunStart(lifecycle: WorkflowRunLifecycle): void {
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

function emitRunResume(lifecycle: WorkflowRunLifecycle): void {
	lifecycle.ctx.emitEvent({
		type: 'run_resume',
		runId: lifecycle.runId,
		owner: lifecycle.owner,
		instanceId: lifecycle.owner.instanceId,
		workflowName: lifecycle.owner.workflowName,
		startedAt: lifecycle.startedAt,
	});
}

/**
 * Emit `run_end` and finalize the run.
 *
 * Terminal ordering matters for `/runs/:runId/stream`: append `run_end`
 * before marking the run terminal, then publish and close subscribers.
 */
async function emitRunEnd(
	lifecycle: WorkflowRunLifecycle,
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
					endedAt,
					isError: input.isError,
					durationMs,
					result: input.isError ? result : normalizedResult,
					error,
				}),
			)
		: false;

	if (didEndRun)
		await safeRegistry('recordRunEnd', () =>
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
 * Per-chunk streaming events are published live but skipped by persistence
 * (see {@link isEphemeralRunEvent}); `run_end` is handled separately by
 * {@link emitRunEnd}.
 */
function subscribeRunFanout(lifecycle: WorkflowRunLifecycle): () => Promise<void> {
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
	if (runStore && !isEphemeralRunEvent(event)) {
		await persistRunEvent('appendEvent', () => runStore.appendEvent(runId, event));
	}
	runSubscribers?.publish(runId, event);
}

async function persistRunEvent(
	label: string,
	fn: () => Promise<void> | undefined,
): Promise<boolean> {
	try {
		await fn();
		return true;
	} catch (error) {
		if (error instanceof RunEventTooLargeError) throw error;
		console.error(`[flue:run-store] ${label} failed:`, error);
		return false;
	}
}

async function persistRunAdmission(
	label: string,
	required: boolean,
	fn: () => Promise<void> | undefined,
): Promise<boolean> {
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
 * Default background workflow runner: invoke `run()` directly so the workflow
 * executes in the current process. Used by the Node target. The Cloudflare
 * target overrides this with a `runFiber` wrapper for crash-recoverable
 * execution across DO hibernation.
 */
const defaultStartWorkflowAdmission: StartWorkflowAdmissionFn = (_runId, run) =>
	Promise.resolve().then(run);


