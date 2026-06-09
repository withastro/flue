import type { AgentExecutionStore, AgentSubmission, AgentSubmissionStore } from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import {
	createAgentSubmissionObserverRegistry,
	type createAgentSubmissionSessionHandler,
	createDirectAgentSubmissionInput,
	processSubmission,
	reconcileInterruptedSubmission,
	submissionSyntheticRequest,
} from '../runtime/agent-submissions.ts';
import { type AgentHandler, assertAgentDispatchAdmissionInput, handleAgentRequest } from '../runtime/handle-agent.ts';
import type { AttachedAgentEvent, DirectAgentPayload } from '../types.ts';
import { createSqlAgentExecutionStore } from './agent-execution-store.ts';
import {
	type CloudflareWebSocketConnection,
	closeFlueSocket,
	connectCloudflareAgentWebSocket,
	isFlueSocket,
	messageCloudflareAgentWebSocket,
	socketRequestUrl,
} from './websocket.ts';

export const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';

const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';
const FLUE_AGENT_SUBMISSION_WAKE_SECONDS = 30;
const FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS = 15 * 60 * 1000;
const FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER = 'flue:submission-attempt';

import type { SqlStorage } from '../sql-storage.ts';

interface CloudflareAgentStorage {
	sql?: SqlStorage;
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
	readonly executionStore: AgentExecutionStore;
}

interface CloudflareAgentRuntimeOptions {
	readonly createdAgents: Record<string, Parameters<typeof createAgentSubmissionSessionHandler>[0]>;
	readonly directHandlers: Record<string, AgentHandler>;
	readonly websocketAgentHandlers: Record<string, AgentHandler>;
	readonly createContext: (options: {
		readonly executionStore: AgentExecutionStore;
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
	readonly createEventStreamStore?: (instance: CloudflareAgentInstance) => import('../runtime/event-stream-store.ts').EventStreamStore | undefined;
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
		if (!(await this.submissions.hasUnsettledSubmissions())) return;
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
				id: this.instance.name,
				admitAttachedSubmission: (payload, onEvent) => this.admitAttachedSubmission(payload, onEvent),
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
		if (!isFlueSocket(connection, 'agent', this.agentName)) return inherited();
		await this.instance.__unsafe_ensureInitialized();
		const handler = this.options.websocketAgentHandlers[this.agentName];
		if (!handler) return;
		return this.runWithInstanceContext(() =>
			messageCloudflareAgentWebSocket(connection, message, {
				name: this.agentName,
				id: this.instance.name,
				request: socketRequest(connection),
				createContext: (_id, _runId, payload, req) => this.createContext(payload, req),
				admitAttachedSubmission: (payload, onEvent) => this.admitAttachedSubmission(payload, onEvent),
			}),
		);
	}

	webSocketClose(
		connection: CloudflareWebSocketConnection,
		code: number,
		reason: string,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> | unknown {
		if (!isFlueSocket(connection, 'agent', this.agentName)) return inherited();
		return closeFlueSocket(connection, code, reason);
	}

	webSocketError(
		connection: CloudflareWebSocketConnection,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> | unknown {
		if (!isFlueSocket(connection, 'agent', this.agentName)) return inherited();
		return closeFlueSocket(connection, 1011, 'WebSocket error');
	}

	async onFiberRecovered(
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> {
		if (ctx.name !== FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER) return inherited();
		const submissionId = ctx.snapshot?.submissionId;
		const attemptId = ctx.snapshot?.attemptId;
		if (typeof submissionId !== 'string' || typeof attemptId !== 'string') return inherited();
		await this.restoreSubmissionWake();
		await this.submissions.requestSubmissionRecovery({ submissionId, attemptId });
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
	}

	private get agentName(): string {
		return this.prepared.agentName;
	}

	private get executionStore(): AgentExecutionStore {
		return this.prepared.executionStore;
	}

	private get submissions(): AgentSubmissionStore {
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

	private async restoreSubmissionWake(): Promise<boolean> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return false;
		await this.armSubmissionWake();
		return true;
	}

	private async reconcileSubmissions(options: { driverAlreadyArmed?: boolean } = {}): Promise<boolean> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return false;
		if (!options.driverAlreadyArmed) await this.restoreSubmissionWake();
		try {
			const attemptMarkers = this.listActiveAttemptMarkers();
			for (const submission of await this.submissions.listRunningSubmissions()) {
				if (this.activeAttempts.has(this.submissionAttemptLocalKey(submission))) continue;
				if (
					attemptMarkers.has(submissionAttemptMarkerKey(submission)) &&
					submission.recoveryRequestedAt === undefined
				)
					continue;
				try {
					await this.reconcileInterruptedSubmission(submission);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, 'reconcile_submission', error);
				}
			}
			for (const submission of await this.submissions.listRunnableSubmissions()) {
			// Cloudflare DOs are single-threaded per instance — leases are
			// advisory-only. Set to 0 so reconciliation never misidentifies
			// an active submission as expired. The Node coordinator uses real
			// lease expiry with heartbeat renewal for multi-process safety.
			const claimed = await this.submissions.claimSubmission({
				submissionId: submission.submissionId,
				attemptId: crypto.randomUUID(),
				ownerId: this.instance.ctx.id.toString(),
				leaseExpiresAt: 0,
			});
				if (!claimed) continue;
				try {
					this.startSubmissionAttempt(claimed);
				} catch (error) {
					this.logSubmissionReconciliationFailure(claimed, 'start_submission', error);
				}
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
		return await this.submissions.hasUnsettledSubmissions();
	}

	private logSubmissionReconciliationFailure(
		submission: AgentSubmission,
		operation: 'reconcile_submission' | 'start_submission',
		error: unknown,
	): void {
		console.error(
			'[flue:submission-reconciliation]',
			{
				agentName: this.agentName,
				instanceId: this.instance.name,
				submissionId: submission.submissionId,
				sessionKey: submission.sessionKey,
				attemptId: submission.attemptId,
				operation,
				outcome: 'deferred_to_scheduled_wake',
			},
			error,
		);
	}

	private async reconcileInterruptedSubmission(submission: AgentSubmission): Promise<void> {
		const agent = this.options.createdAgents[this.agentName];
		if (!agent) throw new Error('[flue] Agent target unavailable during durable reconciliation.');
		const { replacement, failedError } = await this.runWithInstanceContext(() =>
			reconcileInterruptedSubmission(
				this.submissions,
				submission,
				agent,
				(payload, dispatchId) =>
					this.createContext(payload, submissionSyntheticRequest(submission.input), undefined, dispatchId),
				{ ownerId: this.instance.ctx.id.toString(), leaseExpiresAt: 0 },
			),
		);
		if (replacement) {
			this.startSubmissionAttempt(replacement);
		} else if (failedError && submission.kind === 'direct') {
			this.observers.fail(submission.submissionId, failedError);
		}
	}

	private startSubmissionAttempt(submission: AgentSubmission): void {
		if (submission.status !== 'running' || !submission.attemptId) return;
		const attemptKey = this.submissionAttemptLocalKey(submission);
		if (this.activeAttempts.has(attemptKey)) return;
		this.assertAgentsDurabilityApi('runFiber');
		this.activeAttempts.add(attemptKey);
		let running: Promise<void>;
		try {
			running = this.instance.runFiber(FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER, async (fiberCtx) => {
				fiberCtx.stash({ submissionId: submission.submissionId, attemptId: submission.attemptId });
				await this.processSubmissionEntry(submission);
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

	private submissionAttemptLocalKey(submission: AgentSubmission): string {
		return `${this.instance.ctx.id.toString()}:${submission.attemptId}`;
	}

	private listActiveAttemptMarkers(): Set<string> {
		const keys = new Set<string>();
		const rows = this.instance.ctx.storage.sql
			?.exec(
				'SELECT snapshot, created_at FROM cf_agents_runs WHERE name = ?',
				FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER,
			)
			.toArray();
		if (!rows) throw new Error('[flue] Cloudflare durable agent SQL storage is unavailable.');
		for (const row of rows) {
			if (typeof row.created_at !== 'number') {
				console.warn('[flue:submission-reconciliation] Skipping attempt marker with non-numeric created_at.');
				continue;
			}
			if (Date.now() - row.created_at > FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS) continue;
			if (row.snapshot === null) continue;
			if (typeof row.snapshot !== 'string') {
				console.warn('[flue:submission-reconciliation] Skipping attempt marker with non-string snapshot.');
				continue;
			}
			let snapshot: unknown;
			try {
				snapshot = JSON.parse(row.snapshot);
			} catch {
				console.warn('[flue:submission-reconciliation] Skipping attempt marker with unparseable snapshot.');
				continue;
			}
			if (!isAttemptMarkerSnapshot(snapshot)) {
				console.warn('[flue:submission-reconciliation] Skipping attempt marker with invalid snapshot shape.');
				continue;
			}
			keys.add(`${snapshot.submissionId}:${snapshot.attemptId}`);
		}
		return keys;
	}

	private async processSubmissionEntry(submission: AgentSubmission): Promise<void> {
		const eventStreamStore = this.options.createEventStreamStore?.(this.instance);
		await processSubmission({
			submissions: this.submissions,
			submission,
			resolveAgent: (name) => {
				const agent = this.options.createdAgents[name];
				if (!agent) throw new Error('[flue] Agent target unavailable during durable processing.');
				return agent;
			},
			createContext: (payload, dispatchId) => {
				const ctx = this.createContext(payload, submissionSyntheticRequest(submission.input), undefined, dispatchId);
				if (eventStreamStore) {
					const streamPath = `agents/${this.agentName}/${this.instance.name}`;
					eventStreamStore.createStream(streamPath);
					ctx.subscribeEvent((event) => {
						try {
							eventStreamStore.appendEvent(streamPath, event);
						} catch (error) {
							console.error('[flue:event-stream] appendEvent failed:', error);
						}
					});
				}
				return ctx;
			},
			observers: this.observers,
			wrapExecution: (fn) => this.runWithInstanceContext(fn),
			onSettled: () => {
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
			},
		});
	}

	private async admitAttachedSubmission(
		payload: DirectAgentPayload,
		onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
	): Promise<unknown> {
		const input = createDirectAgentSubmissionInput({ agent: this.agentName, id: this.instance.name, payload });
		const attachment = this.observers.attach(input.submissionId, { onEvent });
		try {
			await this.armSubmissionWake();
			await this.submissions.admitDirect(input);
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
			return await attachment.completion;
		} catch (error) {
			// If admission or reconciliation fails before the claim loop
			// could pick up this submission, fail the observer so the
			// caller's completion promise rejects instead of hanging.
			this.observers.fail(input.submissionId, error);
			throw error;
		} finally {
			attachment.detach();
		}
	}

	private async admitDispatch(request: Request): Promise<Response> {
		const input: unknown = await request.json();
		assertAgentDispatchAdmissionInput(input);
		if (input.agent !== this.agentName || input.id !== this.instance.name) {
			return new Response('Invalid internal dispatch target.', { status: 400 });
		}
		if (!this.options.createdAgents[this.agentName]) {
			return new Response('Dispatch target unavailable.', { status: 404 });
		}
		await this.armSubmissionWake();
		const admission = await this.submissions.admitDispatch(input);
		if (admission.kind === 'retained_receipt') {
			return Response.json({
				dispatchId: admission.receipt.submissionId,
				acceptedAt: new Date(admission.receipt.acceptedAt).toISOString(),
			});
		}
		if (admission.kind === 'conflict') {
			return new Response('Conflicting internal dispatch replay.', { status: 409 });
		}
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
		return Response.json({ dispatchId: admission.submission.submissionId, acceptedAt: input.acceptedAt });
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

function submissionAttemptMarkerKey(submission: AgentSubmission): string {
	return `${submission.submissionId}:${submission.attemptId}`;
}

function isInternalDispatchRequest(request: Request): boolean {
	return request.method === 'POST' && new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH;
}

function isWebSocketUpgrade(request: Request): boolean {
	return request.method === 'GET' && request.headers.get('upgrade')?.toLowerCase() === 'websocket';
}

function socketRequest(connection: CloudflareWebSocketConnection): Request {
	const attachment = connection.deserializeAttachment?.();
	return new Request(attachment?.requestUrl || 'https://flue.invalid/');
}
