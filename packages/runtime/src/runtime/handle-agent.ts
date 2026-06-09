/** Shared per-agent HTTP dispatcher for the Node and Cloudflare targets. */

import type { FlueContextInternal } from '../client.ts';
import {
	InvalidRequestError,
	parseJsonBody,
	RunStoreUnavailableError,
	toHttpResponse,
} from '../errors.ts';
import type {
	AttachedAgentEventCallback,
	CreatedAgent,
	DirectAgentPayload,
	FlueEvent,
	FlueEventCallback,
} from '../types.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type { DispatchInput } from './dispatch-queue.ts';
import type { EventStreamStore } from './event-stream-store.ts';

import { generateWorkflowRunId } from './ids.ts';
import type { RunOwner, RunRegistry } from './run-registry.ts';
import { assertPersistedWorkflowEvent, type RunStore } from './run-store.ts';


/** Direct agent handler signature used by attached HTTP prompts. */
export type AgentHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;
export type WorkflowHandler = (ctx: FlueContextInternal) => unknown | Promise<unknown>;

interface DirectRequestSession {
	processDirectInput(input: { message: string }): PromiseLike<unknown>;
}

export function assertAgentDispatchAdmissionInput(input: unknown): asserts input is DispatchInput {
	if (!isDispatchInput(input))
		throw new Error('[flue] Internal dispatch admission received an invalid payload.');
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
		const session = await harness.session();
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
	const expected = 'Direct agent requests must use JSON object body { "message": string }.';
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new InvalidRequestError({ reason: expected });
	}
	const value = payload as { message?: unknown };
	if (typeof value.message !== 'string') {
		throw new InvalidRequestError({ reason: expected });
	}
	return { message: value.message };
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
	runRegistry?: RunRegistry;
	eventStreamStore?: EventStreamStore;
	runId?: string;
}

/**
 * Handle one attached `/agents/:name/:id` prompt interaction.
 *
 * Returns synchronous JSON `{ result }`. Former `X-Webhook: true` agent
 * requests are rejected because asynchronous delivery uses `dispatch(...)`.
 * Events are available via the DS stream read endpoint (GET on the same URL).
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
		const streamUrl = new URL(request.url).toString();
		const offset = '-1';
		if (new URL(request.url).searchParams.get('wait') === 'result') {
			return runDirectSyncMode(directOptions, streamUrl, offset);
		}
		void opts.admitAttachedSubmission(payload);
		return new Response(JSON.stringify({ streamUrl, offset }), {
			status: 202,
			headers: { 'content-type': 'application/json' },
		});
	} catch (err) {
		return toHttpResponse(err);
	}
}

export async function handleWorkflowRequest(opts: HandleWorkflowOptions): Promise<Response> {
	const {
		request,
		workflowName,
		handler,
		createContext,
		runStore,
		runRegistry,
		eventStreamStore,
	} = opts;
	const startWorkflowAdmission = opts.startWorkflowAdmission ?? defaultStartWorkflowAdmission;
	const runId = opts.runId ?? generateWorkflowRunId(workflowName);
	const instanceId = runId;

	try {
		const payload = await parseJsonBody(request);
		const wait = new URL(request.url).searchParams.get('wait');
		const owner = { kind: 'workflow' as const, workflowName, instanceId };

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
			runRegistry,
			eventStreamStore,
		});

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
	runRegistry?: RunRegistry;
	eventStreamStore?: EventStreamStore;
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
	runRegistry?: RunRegistry;
	eventStreamStore?: EventStreamStore;
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
	runRegistry?: RunRegistry;
	eventStreamStore?: EventStreamStore;
	onAdmitted?: (runId: string) => void;
	onEvent?: FlueEventCallback;
	emitIdleOnComplete?: boolean;
}

interface AdmittedWorkflowExecution {
	runId: string;
	runStore: RunStore;
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
		runRegistry,
		eventStreamStore,
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
		runRegistry,
		eventStreamStore,
		requirePersistedAdmission: true,
	});
	return {
		runId,
		runStore,
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
	const events = await readRecoveryEvents(opts);
	const terminalEvent = findTerminalRunEvent(events);
	const run = await opts.runStore?.getRun(opts.runId);
	if (terminalEvent || (run && run.status !== 'active')) {
		await reconcileTerminalRun(opts, run, terminalEvent);
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
	// Ensure the event stream exists — the original workflow may have crashed
	// before createWorkflowRunLifecycle called createStream. Idempotent.
	await opts.eventStreamStore?.createStream(`runs/${opts.runId}`);
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

async function readRecoveryEvents(opts: FailRecoveredRunOptions): Promise<FlueEvent[]> {
	if (!opts.eventStreamStore) return [];
	const streamPath = `runs/${opts.runId}`;
	// Read all events — recovery needs the full history to find the
	// terminal event and compute the next event index.
	const events: FlueEvent[] = [];
	let offset = '-1';
	while (true) {
		const result = await opts.eventStreamStore.readEvents(streamPath, { offset });
		for (const e of result.events) {
			events.push(e.data as FlueEvent);
		}
		if (result.upToDate || result.events.length === 0) break;
		offset = result.nextOffset;
	}
	return events;
}

async function reconcileTerminalRun(
	opts: FailRecoveredRunOptions,
	run: Awaited<ReturnType<RunStore['getRun']>> | undefined,
	terminalEvent: Extract<FlueEvent, { type: 'run_end' }> | undefined,
): Promise<void> {
	const isError = terminalEvent?.isError ?? run?.isError ?? false;
	const result = terminalEvent?.result !== undefined ? terminalEvent.result : run?.result;
	const error = terminalEvent?.error !== undefined ? terminalEvent.error : run?.error;
	const endedAt = terminalEvent?.timestamp ?? run?.endedAt ?? new Date().toISOString();
	const durationMs = terminalEvent?.durationMs ?? run?.durationMs ?? 0;
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
	// Ensure the event stream is closed so DS readers see EOF. A crash
	// between appendEvent(run_end) and closeStream() can leave the stream
	// permanently open without this repair.
	await opts.eventStreamStore?.closeStream(`runs/${opts.runId}`);
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

async function runDirectSyncMode(opts: DirectAttachedOptions, streamUrl: string, offset: string): Promise<Response> {
	const result = await invokeDirectAttached(opts);
	return new Response(JSON.stringify({ result: result === undefined ? null : result, streamUrl, offset }), {
		headers: { 'content-type': 'application/json' },
	});
}

export async function invokeDirectAttached(opts: DirectAttachedOptions): Promise<unknown> {
	return opts.admitAttachedSubmission(opts.payload, opts.onEvent);
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
		runRegistry: opts.runRegistry,
		eventStreamStore: opts.eventStreamStore,
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
		runRegistry: opts.runRegistry,
		eventStreamStore: opts.eventStreamStore,
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
	runRegistry?: RunRegistry;
	eventStreamStore?: EventStreamStore;
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
	// Create the durable event stream for this workflow run.
	await options.eventStreamStore?.createStream(`runs/${options.runId}`);
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
 * Terminal ordering: append `run_end` to the event stream store and close it,
 * then persist to the run store and record in the registry.
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

	const { runStore, runRegistry, eventStreamStore, runId } = lifecycle;

	// Decorate through the shared event path so eventIndex/timestamp stay continuous.
	const decorated = lifecycle.ctx.emitEvent({
		type: 'run_end',
		runId,
		result: normalizedResult,
		isError: input.isError,
		error,
		durationMs,
	});

	// Append run_end to the durable event stream, then close it.
	// Each operation is individually guarded so a store failure cannot
	// prevent RunStore/RunRegistry finalization below.
	try { await eventStreamStore?.appendEvent(`runs/${runId}`, decorated); }
	catch (e) { console.error('[flue:event-stream] appendEvent(run_end) failed:', e); }
	try { await eventStreamStore?.closeStream(`runs/${runId}`); }
	catch (e) { console.error('[flue:event-stream] closeStream failed:', e); }

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

}

/**
 * Persist non-terminal events to the event stream store.
 * `run_end` is handled separately by {@link emitRunEnd}.
 *
 * Because `emitEvent` dispatches to subscribers synchronously (fire-and-forget),
 * async `appendEvent` calls produce floating promises. We collect them in a
 * buffer and drain at the returned flush function, which is awaited by
 * {@link withWorkflowRunLifecycle} after the workflow body completes.
 */
function subscribeRunFanout(lifecycle: WorkflowRunLifecycle): () => Promise<void> {
	const { ctx, eventStreamStore, runId } = lifecycle;
	if (!eventStreamStore) return async () => {};
	const pending: Promise<void>[] = [];
	const unsubscribe = ctx.subscribeEvent((event) => {
		if (event.type === 'run_end') return;
		pending.push(
			eventStreamStore.appendEvent(`runs/${runId}`, event).then(
				() => {},
				(error) => { console.error('[flue:event-stream] appendEvent failed:', error); },
			),
		);
	});
	return async () => {
		unsubscribe();
		await Promise.all(pending);
	};
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

// ─── Defaults ───────────────────────────────────────────────────────────────

/**
 * Default background workflow runner: invoke `run()` directly so the workflow
 * executes in the current process. Used by the Node target. The Cloudflare
 * target overrides this with a `runFiber` wrapper for crash-recoverable
 * execution across DO hibernation.
 */
const defaultStartWorkflowAdmission: StartWorkflowAdmissionFn = (_runId, run) =>
	Promise.resolve().then(run);


