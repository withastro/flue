import type { FlueContextInternal } from '../client.ts';
import {
	agentSubmissionContextPayload,
	agentSubmissionDispatchId,
	agentSubmissionInspectionContextPayload,
	createAgentSubmissionHandler,
	createAgentSubmissionInspectionHandler,
	createAgentSubmissionObserverRegistry,
	createAgentSubmissionTerminalHandler,
	type DirectAgentSubmissionInput,
} from '../runtime/agent-submissions.ts';
import type { DispatchInput } from '../runtime/dispatch-queue.ts';
import { type AgentHandler, handleAgentRequest, validateAgentDispatchAdmission } from '../runtime/handle-agent.ts';
import type { AttachedAgentEvent, DirectAgentPayload } from '../types.ts';
import {
	createSqlAgentExecutionStore,
	type SqlAgentExecutionStore,
	type SqlAgentSubmission,
	SqlAgentSubmissionConflictError,
	type SqlAgentSubmissionStore,
	type SubmissionAttemptRef,
} from './agent-execution-store.ts';
import {
	type CloudflareWebSocketConnection,
	connectCloudflareAgentWebSocket,
	messageCloudflareAgentWebSocket,
} from './websocket.ts';

export const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';

const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';
const FLUE_AGENT_SUBMISSION_WAKE_SECONDS = 30;
const FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS = 15 * 60 * 1000;
const FLUE_AGENT_SUBMISSION_TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER = 'flue:submission-attempt';

interface SqlResult {
	toArray(): Array<Record<string, unknown>>;
}

interface CloudflareAgentStorage {
	sql?: {
		exec(query: string, ...bindings: unknown[]): SqlResult;
	};
	transactionSync?<T>(closure: () => T): T;
}

interface CloudflareAgentInstance {
	readonly name: string;
	readonly env: Record<string, unknown>;
	readonly ctx: {
		readonly id: { toString(): string };
		readonly storage: CloudflareAgentStorage;
		acceptWebSocket(connection: CloudflareWebSocketConnection): void;
	};
	__unsafe_ensureInitialized(): Promise<void>;
	schedule(
		delaySeconds: number,
		callback: string,
		payload: undefined,
		options: { idempotent: boolean },
	): Promise<unknown>;
	runFiber(
		name: string,
		callback: (ctx: { stash(snapshot: unknown): void }) => Promise<void>,
	): Promise<void>;
}

interface CloudflareAgentRecoveredFiberContext {
	readonly name?: string;
	readonly snapshot?: Record<string, unknown>;
}

interface CloudflareAgentPreparedCoordinator {
	readonly agentName: string;
	readonly executionStore: SqlAgentExecutionStore;
}

interface CloudflareAgentRuntimeOptions {
	readonly createdAgents: Record<string, Parameters<typeof createAgentSubmissionHandler>[0]>;
	readonly directHandlers: Record<string, AgentHandler>;
	readonly websocketAgentHandlers: Record<string, AgentHandler>;
	readonly createContext: (options: {
		readonly executionStore: SqlAgentExecutionStore;
		readonly instance: CloudflareAgentInstance;
		readonly payload: unknown;
		readonly request: Request;
		readonly initialEventIndex?: number;
		readonly dispatchId?: string;
	}) => FlueContextInternal;
	readonly runWithInstanceContext: <T>(
		instance: CloudflareAgentInstance,
		agentName: string,
		callback: () => T,
	) => T;
	readonly createWebSocketPair: () => {
		readonly client: unknown;
		readonly server: CloudflareWebSocketConnection;
	};
}

export interface CloudflareAgentRuntime {
	prepare(options: {
		readonly storage: CloudflareAgentStorage;
		readonly className: string;
		readonly agentName: string;
	}): CloudflareAgentPreparedCoordinator;
	attach(instance: CloudflareAgentInstance, prepared: CloudflareAgentPreparedCoordinator): void;
	onStart(
		instance: CloudflareAgentInstance,
		inherited: () => Promise<unknown> | unknown,
	): Promise<void>;
	wakeSubmissions(instance: CloudflareAgentInstance): Promise<void>;
	onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
	fetch(
		instance: CloudflareAgentInstance,
		request: Request,
		inherited: () => Promise<Response> | Response,
	): Promise<Response>;
	webSocketMessage(
		instance: CloudflareAgentInstance,
		connection: CloudflareWebSocketConnection,
		message: string | ArrayBuffer | ArrayBufferView,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
	webSocketClose(
		instance: CloudflareAgentInstance,
		connection: CloudflareWebSocketConnection,
		code: number,
		reason: string,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> | unknown;
	webSocketError(
		instance: CloudflareAgentInstance,
		connection: CloudflareWebSocketConnection,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> | unknown;
	onFiberRecovered(
		instance: CloudflareAgentInstance,
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
}

export function createCloudflareAgentRuntime(options: CloudflareAgentRuntimeOptions): CloudflareAgentRuntime {
	const coordinators = new WeakMap<CloudflareAgentInstance, CloudflareAgentCoordinator>();
	const observers = createAgentSubmissionObserverRegistry();
	const activeAttempts = new Set<string>();

	const getCoordinator = (instance: CloudflareAgentInstance): CloudflareAgentCoordinator => {
		const coordinator = coordinators.get(instance);
		if (!coordinator) {
			throw new Error('[flue] Generated Cloudflare agent coordinator was not initialized.');
		}
		return coordinator;
	};

	return {
		prepare({ storage, className, agentName }) {
			return {
				agentName,
				executionStore: createSqlAgentExecutionStore(storage, className),
			};
		},
		attach(instance, prepared) {
			coordinators.set(
				instance,
				new CloudflareAgentCoordinator(instance, prepared, options, observers, activeAttempts),
			);
		},
		onStart(instance, inherited) {
			return getCoordinator(instance).onStart(inherited);
		},
		wakeSubmissions(instance) {
			return getCoordinator(instance).wakeSubmissions();
		},
		onRequest(instance, request) {
			return getCoordinator(instance).onRequest(request);
		},
		fetch(instance, request, inherited) {
			return getCoordinator(instance).fetch(request, inherited);
		},
		webSocketMessage(instance, connection, message, inherited) {
			return getCoordinator(instance).webSocketMessage(connection, message, inherited);
		},
		webSocketClose(instance, connection, code, reason, inherited) {
			return getCoordinator(instance).webSocketClose(connection, code, reason, inherited);
		},
		webSocketError(instance, connection, inherited) {
			return getCoordinator(instance).webSocketError(connection, inherited);
		},
		onFiberRecovered(instance, ctx, inherited) {
			return getCoordinator(instance).onFiberRecovered(ctx, inherited);
		},
	};
}

class CloudflareAgentCoordinator {
	constructor(
		private readonly instance: CloudflareAgentInstance,
		private readonly prepared: CloudflareAgentPreparedCoordinator,
		private readonly options: CloudflareAgentRuntimeOptions,
		private readonly observers: ReturnType<typeof createAgentSubmissionObserverRegistry>,
		private readonly activeAttempts: Set<string>,
	) {}

	async onStart(inherited: () => Promise<unknown> | unknown): Promise<void> {
		await this.restoreSubmissionWake();
		await inherited();
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
	}

	async wakeSubmissions(): Promise<void> {
		if (!this.submissions.hasUnsettledSubmissions()) return;
		await this.armSubmissionWake({ idempotent: false });
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
	}

	async onRequest(request: Request): Promise<Response | null> {
		if (isInternalDispatchRequest(request)) return this.admitDispatch(request);
		const handler = this.options.directHandlers[this.agentName];
		if (!handler) throw new Error('[flue] Agent direct handler is unavailable.');
		return this.runWithInstanceContext(() =>
			handleAgentRequest({
				request,
				agentName: this.agentName,
				id: this.instance.name,
				handler,
				createContext: (_id, _runId, payload, req, initialEventIndex, dispatchId) =>
					this.createContext(payload, req, initialEventIndex, dispatchId),
				admitAttachedSubmission: (payload, _req, onEvent) =>
					this.admitAttachedSubmission(payload, onEvent),
			}),
		);
	}

	async fetch(request: Request, inherited: () => Promise<Response> | Response): Promise<Response> {
		if (!isWebSocketUpgrade(request)) return inherited();
		await this.instance.__unsafe_ensureInitialized();
		return this.acceptSocket(request);
	}

	async webSocketMessage(
		connection: CloudflareWebSocketConnection,
		message: string | ArrayBuffer | ArrayBufferView,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> {
		if (!isFlueAgentSocket(connection, this.agentName)) return inherited();
		await this.instance.__unsafe_ensureInitialized();
		const handler = this.options.websocketAgentHandlers[this.agentName];
		if (!handler) return;
		return this.runWithInstanceContext(() =>
			messageCloudflareAgentWebSocket(connection, message, {
				name: this.agentName,
				id: this.instance.name,
				request: socketRequest(connection),
				handler,
				createContext: (_id, _runId, payload, req) => this.createContext(payload, req),
				admitAttachedSubmission: (payload, _req, onEvent) =>
					this.admitAttachedSubmission(payload, onEvent),
			}),
		);
	}

	webSocketClose(
		connection: CloudflareWebSocketConnection,
		code: number,
		reason: string,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> | unknown {
		if (!isFlueAgentSocket(connection, this.agentName)) return inherited();
		return closeSocket(connection, code, reason);
	}

	webSocketError(
		connection: CloudflareWebSocketConnection,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> | unknown {
		if (!isFlueAgentSocket(connection, this.agentName)) return inherited();
		return closeSocket(connection, 1011, 'WebSocket error');
	}

	async onFiberRecovered(
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> {
		if (ctx.name !== FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER) return inherited();
		const submissionId = ctx.snapshot?.submissionId;
		const attemptId = ctx.snapshot?.attemptId;
		if (typeof submissionId !== 'string' || typeof attemptId !== 'string') return;
		await this.restoreSubmissionWake();
		this.submissions.requestSubmissionRecovery({ submissionId, attemptId });
	}

	private get agentName(): string {
		return this.prepared.agentName;
	}

	private get executionStore(): SqlAgentExecutionStore {
		return this.prepared.executionStore;
	}

	private get submissions(): SqlAgentSubmissionStore {
		return this.executionStore.submissions;
	}

	private runWithInstanceContext<T>(callback: () => T): T {
		return this.options.runWithInstanceContext(this.instance, this.agentName, callback);
	}

	private createContext(
		payload: unknown,
		request: Request,
		initialEventIndex?: number,
		dispatchId?: string,
	): FlueContextInternal {
		return this.options.createContext({
			executionStore: this.executionStore,
			instance: this.instance,
			payload,
			request,
			initialEventIndex,
			dispatchId,
		});
	}

	private assertAgentsDurabilityApi(method: 'runFiber' | 'schedule'): void {
		if (typeof this.instance[method] !== 'function') {
			throw new Error(
				`[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "${method}". Install or upgrade the "agents" package in your project.`,
			);
		}
	}

	private armSubmissionWake(options: { delaySeconds?: number; idempotent?: boolean } = {}): Promise<unknown> {
		this.assertAgentsDurabilityApi('schedule');
		return this.instance.schedule(
			options.delaySeconds ?? FLUE_AGENT_SUBMISSION_WAKE_SECONDS,
			FLUE_AGENT_SUBMISSION_WAKE_CALLBACK,
			undefined,
			{ idempotent: options.idempotent ?? true },
		);
	}

	private cleanupTerminalState(): number {
		return this.submissions.cleanupTerminalSubmissions(
			Date.now() - FLUE_AGENT_SUBMISSION_TERMINAL_RETENTION_MS,
		);
	}

	private async restoreSubmissionWake(): Promise<boolean> {
		if (!this.submissions.hasUnsettledSubmissions()) return false;
		await this.armSubmissionWake();
		return true;
	}

	private async reconcileSubmissions(options: { driverAlreadyArmed?: boolean } = {}): Promise<boolean> {
		this.cleanupTerminalState();
		if (!this.submissions.hasUnsettledSubmissions()) return false;
		if (!options.driverAlreadyArmed) await this.restoreSubmissionWake();
		if (!this.submissions.hasUnsettledSubmissions()) return false;
		try {
			const attemptMarkers = this.listActiveAttemptMarkers();
			if (attemptMarkers.blockAll) return true;
			for (const submission of this.submissions.listRunningSubmissions()) {
				if (this.activeAttempts.has(this.submissionAttemptLocalKey(submission))) continue;
				if (
					submission.status !== 'recording_interruption' &&
					attemptMarkers.keys.has(submissionAttemptMarkerKey(submission)) &&
					submission.recoveryRequestedAt === undefined
				)
					continue;
				await this.reconcileInterruptedSubmission(submission);
			}
			for (const submission of this.submissions.listRunnableSubmissions()) {
				const claimed = this.submissions.claimSubmission({
					submissionId: submission.submissionId,
					attemptId: crypto.randomUUID(),
				});
				if (claimed) this.startSubmissionAttempt(claimed);
			}
		} catch (error) {
			console.error(
				'[flue:submission-reconciliation]',
				{
					agentName: this.agentName,
					instanceId: this.instance.name,
					operation: 'reconcile',
					outcome: 'deferred_to_scheduled_wake',
				},
				error,
			);
			return true;
		}
		return this.submissions.hasUnsettledSubmissions();
	}

	private async reconcileInterruptedSubmission(submission: SqlAgentSubmission): Promise<void> {
		const { input } = submission;
		const attempt = submissionAttemptRef(submission);
		if (!attempt) return;
		if (submission.status === 'recording_interruption') {
			await this.failInterruptedSubmission(
				submission,
				submission.inputAppliedAt === undefined
					? 'interrupted_before_input_marker'
					: 'interrupted_after_input_application',
				new Error(
					submission.inputAppliedAt === undefined
						? '[flue] Agent submission attempt was interrupted after canonical input persistence but before the input-application marker was recorded. Provider replay was not attempted.'
						: '[flue] Agent submission attempt was interrupted after input application without a completed canonical response. Provider replay was not attempted.',
				),
			);
			return;
		}
		const agent = this.options.createdAgents[this.agentName];
		if (!agent) throw new Error('[flue] Agent target unavailable during durable reconciliation.');
		const request = new Request(`https://flue.invalid${CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH}`, {
			method: 'POST',
		});
		const ctx = this.createContext(
			agentSubmissionInspectionContextPayload(input),
			request,
			undefined,
			agentSubmissionDispatchId(input),
		);
		const state = await this.runWithInstanceContext(() =>
			createAgentSubmissionInspectionHandler(agent, input)(ctx),
		);
		if (submission.inputAppliedAt === undefined) {
			if (state === 'absent') {
				this.submissions.requeueSubmissionBeforeInputApplied(attempt);
				return;
			}
			await this.failInterruptedSubmission(
				submission,
				'interrupted_before_input_marker',
				new Error(
					'[flue] Agent submission attempt was interrupted after canonical input persistence but before the input-application marker was recorded. Provider replay was not attempted.',
				),
			);
			return;
		}
		if (state === 'completed') {
			this.submissions.completeSubmission(attempt);
			return;
		}
		await this.failInterruptedSubmission(
			submission,
			'interrupted_after_input_application',
			new Error(
				'[flue] Agent submission attempt was interrupted after input application without a completed canonical response. Provider replay was not attempted.',
			),
		);
	}

	private async failInterruptedSubmission(
		submission: SqlAgentSubmission,
		reason: 'interrupted_before_input_marker' | 'interrupted_after_input_application',
		error: Error,
	): Promise<void> {
		const { input } = submission;
		const attempt = submissionAttemptRef(submission);
		if (!attempt) return;
		if (
			submission.status !== 'recording_interruption' &&
			!this.submissions.beginSubmissionInterruptionRecording(attempt)
		)
			return;
		const agent = this.options.createdAgents[this.agentName];
		if (!agent) throw new Error('[flue] Agent target unavailable during durable terminalization.');
		const request = new Request(`https://flue.invalid${CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH}`, {
			method: 'POST',
		});
		const ctx = this.createContext(
			agentSubmissionContextPayload(input),
			request,
			undefined,
			agentSubmissionDispatchId(input),
		);
		await this.runWithInstanceContext(() =>
			createAgentSubmissionTerminalHandler(agent, input, {
				submissionId: submission.submissionId,
				kind: submission.kind,
				reason,
				message: error.message,
			})(ctx),
		);
		const failed = this.submissions.finishSubmissionInterruptionRecording(attempt, error);
		if (failed && submission.kind === 'direct') this.observers.fail(submission.submissionId, error);
	}

	private startSubmissionAttempt(submission: SqlAgentSubmission): void {
		if (submission.status !== 'running' || !submission.attemptId) return;
		const attemptKey = this.submissionAttemptLocalKey(submission);
		if (this.activeAttempts.has(attemptKey)) return;
		this.assertAgentsDurabilityApi('runFiber');
		this.activeAttempts.add(attemptKey);
		let running: Promise<void>;
		try {
			running = this.instance.runFiber(FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER, async (fiberCtx) => {
				fiberCtx.stash({ submissionId: submission.submissionId, attemptId: submission.attemptId });
				await this.processSubmission(submission);
			});
		} catch (error) {
			this.activeAttempts.delete(attemptKey);
			throw error;
		}
		void running
			.catch((error) => {
				console.error(
					'[flue:submission-processing]',
					{
						agentName: this.agentName,
						instanceId: this.instance.name,
						submissionId: submission.submissionId,
						operation: 'process',
						outcome: 'failed',
					},
					error,
				);
			})
			.finally(() => {
				this.activeAttempts.delete(attemptKey);
			});
	}

	private submissionAttemptLocalKey(submission: SqlAgentSubmission): string {
		return `${this.instance.ctx.id.toString()}:${submission.attemptId}`;
	}

	private listActiveAttemptMarkers(): { blockAll: boolean; keys: Set<string> } {
		const keys = new Set<string>();
		let blockAll = false;
		const rows = this.instance.ctx.storage.sql
			?.exec(
				`SELECT snapshot, created_at FROM cf_agents_runs WHERE name = '${FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER}'`,
			)
			.toArray();
		if (!rows) throw new Error('[flue] Cloudflare durable agent SQL storage is unavailable.');
		for (const row of rows) {
			if (typeof row.created_at !== 'number') {
				blockAll = true;
				continue;
			}
			if (Date.now() - row.created_at > FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS) continue;
			if (row.snapshot === null) continue;
			if (typeof row.snapshot !== 'string') {
				blockAll = true;
				continue;
			}
			let snapshot: unknown;
			try {
				snapshot = JSON.parse(row.snapshot);
			} catch {
				blockAll = true;
				continue;
			}
			if (!isAttemptMarkerSnapshot(snapshot)) {
				blockAll = true;
				continue;
			}
			keys.add(`${snapshot.submissionId}:${snapshot.attemptId}`);
		}
		return { blockAll, keys };
	}

	private async processSubmission(submission: SqlAgentSubmission): Promise<void> {
		const { input } = submission;
		const attempt = submissionAttemptRef(submission);
		if (!attempt) return;
		const persisted = this.submissions.getSubmission(submission.submissionId);
		if (persisted?.status !== 'running' || persisted.attemptId !== attempt.attemptId) return;
		let ctx: FlueContextInternal | undefined;
		try {
			const agent = this.options.createdAgents[this.agentName];
			if (!agent) throw new Error('[flue] Agent target unavailable during durable processing.');
			if (input.kind === 'dispatch') await validateAgentDispatchAdmission({ input });
			const request =
				input.kind === 'direct'
					? new Request(
							`https://flue.invalid/agents/${encodeURIComponent(this.agentName)}/${encodeURIComponent(this.instance.name)}`,
							{ method: 'POST' },
						)
					: new Request(`https://flue.invalid${CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH}`, {
							method: 'POST',
						});
			ctx = this.createContext(
				agentSubmissionContextPayload(input),
				request,
				undefined,
				agentSubmissionDispatchId(input),
			);
			const operationCtx = ctx;
			if (submission.kind === 'direct') {
				operationCtx.setEventCallback((event) => {
					if (event.type === 'run_start' || event.type === 'run_end') return;
					const attachedEvent = { ...event, instanceId: this.instance.name } as AttachedAgentEvent & {
						runId?: string;
					};
					delete attachedEvent.runId;
					return this.observers.publish(submission.submissionId, attachedEvent);
				});
			}
			const result = await this.runWithInstanceContext(() =>
				createAgentSubmissionHandler(agent, input, {
					onInputApplied: () => this.markInputApplied(attempt),
				})(operationCtx),
			);
			const completed = this.submissions.completeSubmission(attempt);
			if (completed && submission.kind === 'direct') this.observers.complete(submission.submissionId, result);
		} catch (error) {
			const failed = this.submissions.failSubmission(attempt, error);
			if (failed && submission.kind === 'direct') this.observers.fail(submission.submissionId, error);
			throw error;
		} finally {
			if (submission.kind === 'direct') ctx?.setEventCallback(undefined);
			void this.reconcileSubmissions().catch((error) => {
				console.error(
					'[flue:submission-reconciliation]',
					{
						agentName: this.agentName,
						instanceId: this.instance.name,
						operation: 'settlement',
						outcome: 'reconcile_failed',
					},
					error,
				);
			});
		}
	}

	private markInputApplied(attempt: SubmissionAttemptRef): void {
		if (!this.submissions.markSubmissionInputApplied(attempt)) {
			throw new Error('[flue] Agent submission attempt lost ownership before input application.');
		}
	}

	private async admitAttachedSubmission(
		payload: DirectAgentPayload,
		onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
	): Promise<unknown> {
		const submissionId = crypto.randomUUID();
		const input: DirectAgentSubmissionInput = {
			kind: 'direct',
			submissionId,
			agent: this.agentName,
			id: this.instance.name,
			session: typeof payload.session === 'string' && payload.session.trim() !== '' ? payload.session : 'default',
			payload,
			acceptedAt: new Date().toISOString(),
		};
		const attachment = this.observers.attach(submissionId, { onEvent });
		try {
			await this.armSubmissionWake();
			this.submissions.admitDirect(input);
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
			return await attachment.completion;
		} finally {
			attachment.detach();
		}
	}

	private async admitDispatch(request: Request): Promise<Response> {
		const input: unknown = await request.json();
		await validateAgentDispatchAdmission({ input: input as DispatchInput });
		if (!isDispatchInput(input)) {
			throw new Error('[flue] Internal dispatch admission received an invalid payload.');
		}
		if (input.agent !== this.agentName || input.id !== this.instance.name) {
			return new Response('Invalid internal dispatch target.', { status: 400 });
		}
		if (!this.options.createdAgents[this.agentName]) {
			return new Response('Dispatch target unavailable.', { status: 404 });
		}
		this.cleanupTerminalState();
		await this.armSubmissionWake();
		try {
			const admission = this.submissions.admitDispatch(input);
			if (admission.kind === 'retained_receipt') {
				return Response.json({
					dispatchId: admission.receipt.submissionId,
					acceptedAt: new Date(admission.receipt.acceptedAt).toISOString(),
				});
			}
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
			return Response.json({ dispatchId: admission.submission.submissionId, acceptedAt: input.acceptedAt });
		} catch (error) {
			if (error instanceof SqlAgentSubmissionConflictError) {
				return new Response('Conflicting internal dispatch replay.', { status: 409 });
			}
			throw error;
		}
	}

	private acceptSocket(request: Request): Response {
		const handler = this.options.websocketAgentHandlers[this.agentName];
		if (!handler) return new Response(null, { status: 404 });
		const { client, server } = this.options.createWebSocketPair();
		this.instance.ctx.acceptWebSocket(server);
		connectCloudflareAgentWebSocket(server, {
			name: this.agentName,
			id: this.instance.name,
			requestUrl: socketRequestUrl(request),
		});
		return new Response(null, { status: 101, webSocket: client } as ResponseInit);
	}
}

function isAttemptMarkerSnapshot(value: unknown): value is { submissionId: string; attemptId: string } {
	if (!value || typeof value !== 'object') return false;
	const snapshot = value as Record<string, unknown>;
	return typeof snapshot.submissionId === 'string' && typeof snapshot.attemptId === 'string';
}

function isDispatchInput(value: unknown): value is DispatchInput {
	if (!value || typeof value !== 'object') return false;
	const input = value as Partial<DispatchInput>;
	return (
		typeof input.dispatchId === 'string' &&
		typeof input.agent === 'string' &&
		typeof input.id === 'string' &&
		typeof input.session === 'string' &&
		typeof input.acceptedAt === 'string'
	);
}

function submissionAttemptRef(submission: SqlAgentSubmission): SubmissionAttemptRef | undefined {
	return submission.attemptId
		? { submissionId: submission.submissionId, attemptId: submission.attemptId }
		: undefined;
}

function submissionAttemptMarkerKey(submission: SqlAgentSubmission): string {
	return `${submission.submissionId}:${submission.attemptId}`;
}

function isInternalDispatchRequest(request: Request): boolean {
	return request.method === 'POST' && new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH;
}

function isWebSocketUpgrade(request: Request): boolean {
	return request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function isFlueAgentSocket(connection: CloudflareWebSocketConnection, agentName: string): boolean {
	const attachment = connection.deserializeAttachment?.();
	return attachment?.version === 1 && attachment.target === 'agent' && attachment.name === agentName;
}

function closeSocket(connection: CloudflareWebSocketConnection, code: number, reason: string): void {
	if (code === 1005 || code === 1006 || code === 1015) return;
	try {
		connection.close(code, reason);
	} catch {
		return;
	}
}

function socketRequest(connection: CloudflareWebSocketConnection): Request {
	const attachment = connection.deserializeAttachment?.();
	return new Request(attachment?.requestUrl || 'https://flue.invalid/');
}

function socketRequestUrl(request: Request): string {
	const url = new URL(request.url);
	url.search = '';
	url.hash = '';
	return url.toString();
}
