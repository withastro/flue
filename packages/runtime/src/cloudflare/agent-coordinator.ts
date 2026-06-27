import type {
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
} from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import { ConversationRecordWriter } from '../conversation-writer.ts';
import type { FlueTraceCarrier } from '../execution-interceptor.ts';
import {
	createAgentSubmissionObserverRegistry,
	type createAgentSubmissionSessionHandler,
	createDirectAgentSubmissionInput,
	materializeAgentSubmissionSession,
	processSubmission,
	reconcileInterruptedSubmission,
	submissionSyntheticRequest,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import type { AgentInteractionStart } from '../runtime/dev-lifecycle-logger.ts';
import { agentStreamPath } from '../runtime/event-stream-store.ts';
import { assertAgentDispatchAdmissionInput, handleAgentRequest } from '../runtime/handle-agent.ts';
import {
	handleAgentConversationHead,
	handleAgentConversationRead,
} from '../runtime/handle-conversation-routes.ts';
import type { AttachedAgentEvent, DirectAgentPayload } from '../types.ts';
import {
	createSqlAgentExecutionStore,
	createSqlConversationStores,
} from './agent-execution-store.ts';

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
	readonly conversationStreamStore: ConversationStreamStore;
	readonly attachmentStore: AttachmentStore;
}

interface CloudflareAgentRuntimeOptions {
	readonly agents: ReadonlyArray<{
		readonly name: string;
		readonly definition: Parameters<typeof createAgentSubmissionSessionHandler>[0];
	}>;
	readonly createContext: (options: {
		readonly executionStore: AgentExecutionStore;
		readonly instance: CloudflareAgentInstance;
		readonly agentName: string;
		readonly request: Request;
		readonly initialEventIndex?: number;
		readonly dispatchId?: string;
	}) => FlueContextInternal;
	readonly runWithInstanceContext: <T>(
		instance: CloudflareAgentInstance,
		agentName: string,
		callback: () => T,
	) => T;
	readonly onInteractionStart?: (interaction: AgentInteractionStart) => void;
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
	onFiberRecovered(
		instance: CloudflareAgentInstance,
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
}

export function createCloudflareAgentRuntime(
	options: CloudflareAgentRuntimeOptions,
): CloudflareAgentRuntime {
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
			const executionStore = createSqlAgentExecutionStore(storage, className);
			const conversationStores = createSqlConversationStores(storage);
			return {
				agentName,
				executionStore,
				...conversationStores,
			};
		},
		attach(instance, prepared) {
			coordinators.set(
				instance,
				new CloudflareAgentCoordinator(
					instance,
					prepared,
					options,
					observers,
					activeAttempts,
				),
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

	private conversationWriter: ConversationRecordWriter | undefined;
	private conversationMaterialization: Promise<void> = Promise.resolve();

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

		const method = request.method;
		if (method === 'GET' || method === 'HEAD') {
			const streamPath = agentStreamPath(this.agentName, this.instance.name);
			if (method === 'HEAD') {
				return await handleAgentConversationHead(
					this.prepared.conversationStreamStore,
					streamPath,
				);
			}
			return handleAgentConversationRead({
				store: this.prepared.conversationStreamStore,
				path: streamPath,
				request,
			});
		}

		return this.runWithInstanceContext(() =>
			handleAgentRequest({
				request,
				id: this.instance.name,
				agentName: this.agentName,
				conversationStreamStore: this.prepared.conversationStreamStore,
				admitAttachedSubmission: (payload, onEvent, waitForResult, traceCarrier) =>
					this.admitAttachedSubmission(payload, onEvent, waitForResult, traceCarrier),
			}),
		);
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

	private async ensureConversationWriter(): Promise<ConversationRecordWriter> {
		this.conversationWriter ??= await ConversationRecordWriter.create({
			store: this.prepared.conversationStreamStore,
			path: agentStreamPath(this.agentName, this.instance.name),
			identity: { agentName: this.agentName, instanceId: this.instance.name },
			producerId: this.instance.ctx.id.toString(),
		});
		return this.conversationWriter;
	}

	private createContext(
		request: Request,
		initialEventIndex?: number,
		dispatchId?: string,
	): FlueContextInternal {
		return this.options.createContext({
			executionStore: this.executionStore,
			instance: this.instance,
			agentName: this.agentName,
			request,
			initialEventIndex,
			dispatchId,
		});
	}

	private createDurableContext(
		request: Request,
		dispatchId?: string,
	): FlueContextInternal {
		const ctx = this.createContext(request, undefined, dispatchId);
		ctx.setConversationWriter?.(this.conversationWriter);
		ctx.setAttachmentStore?.(this.prepared.attachmentStore);
		return ctx;
	}

	private assertAgentsDurabilityApi(method: 'runFiber' | 'schedule'): void {
		if (typeof this.instance[method] !== 'function') {
			throw new Error(
				`[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "${method}". Install or upgrade the "agents" package in your project.`,
			);
		}
	}

	private armSubmissionWake(
		options: { delaySeconds?: number; idempotent?: boolean } = {},
	): Promise<unknown> {
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

	private async reconcileSubmissions(
		options: { driverAlreadyArmed?: boolean } = {},
	): Promise<boolean> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return false;
		if (!options.driverAlreadyArmed) await this.restoreSubmissionWake();
		try {
			for (const submission of await this.submissions.listUnreadySubmissions()) {
				const agent = this.options.agents.find(
					(record) => record.name === submission.input.agent,
				)?.definition;
				if (!agent || submission.input.agent !== this.agentName || submission.input.id !== this.instance.name) {
					console.error('[flue:submission-reconciliation]', {
						agentName: this.agentName,
						instanceId: this.instance.name,
						submissionId: submission.submissionId,
						sessionKey: submission.sessionKey,
						operation: 'materialize_submission',
						outcome: 'agent_unavailable',
					});
					continue;
				}
				try {
					await this.materializeSubmissionConversation(submission.input, agent);
					await this.submissions.markSubmissionCanonicalReady(submission.submissionId);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, 'materialize_submission', error);
				}
			}
			for (const settlement of await this.submissions.listPendingSubmissionSettlements()) {
				const submission = await this.submissions.getSubmission(settlement.submissionId);
				if (!submission || this.activeAttempts.has(this.submissionAttemptLocalKey(submission))) continue;
				const writer = await this.ensureConversationWriter();
				const attempt = { submissionId: settlement.submissionId, attemptId: settlement.attemptId };
				const canonical = await writer.getRecord(settlement.recordId);
				if (!canonical) await writer.append([settlement.record], { submission: attempt });
				else if (JSON.stringify(canonical) !== JSON.stringify(settlement.record)) {
					throw new Error('[flue] Pending settlement does not match its canonical record. Clear incompatible beta persistence.');
				}
				if (await this.submissions.finalizeSubmissionSettlement(attempt, settlement.recordId)) {
					if (settlement.record.outcome === 'completed') this.observers.complete(settlement.submissionId, settlement.record.result);
					if (settlement.record.outcome === 'failed') {
						const error = settlement.record.error as { message?: string } | undefined;
						this.observers.fail(
							settlement.submissionId,
							new Error(error?.message ?? 'Agent submission failed.'),
						);
					}
				}
			}
			// The marker scan is advisory: a fresh marker suppresses
			// re-reconciling an attempt that may still be running. If the scan
			// itself fails, degrade to an empty marker set instead of aborting —
			// a hard failure here would permanently block claiming and hang
			// attached callers, while double-processing is bounded by the claim
			// CAS and attempt-id ownership checks.
			let attemptMarkers: ReadonlySet<string>;
			try {
				attemptMarkers = await this.listActiveAttemptMarkers();
			} catch (error) {
				attemptMarkers = new Set();
				console.error(
					'[flue:submission-reconciliation]',
					{
						agentName: this.agentName,
						instanceId: this.instance.name,
						operation: 'list_attempt_markers',
						outcome: 'degraded_to_empty_marker_set',
					},
					error,
				);
			}
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
					await this.startSubmissionAttempt(claimed);
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
		operation: 'materialize_submission' | 'reconcile_submission' | 'start_submission',
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
		const conversationWriter = await this.ensureConversationWriter();
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.definition;
		if (!agent) throw new Error('[flue] Agent target unavailable during durable reconciliation.');
		const reconciled = await this.runWithInstanceContext(() =>
			reconcileInterruptedSubmission(
				this.submissions,
				submission,
				agent,
				(dispatchId) =>
					this.createDurableContext(submissionSyntheticRequest(submission.input), dispatchId),
				{ ownerId: this.instance.ctx.id.toString(), leaseExpiresAt: 0 },
				conversationWriter,
			),
		);
		if (reconciled.disposition === 'replacement') {
			await this.startSubmissionAttempt(reconciled.submission);
		} else if (submission.kind === 'direct') {
			// Observer resolution is best-effort and per-process: only a
			// waiting caller attached in this process can be resolved here.
			// Detached observers see the durable settlement event.
			if (reconciled.disposition === 'completed') {
				this.observers.complete(submission.submissionId, reconciled.result);
			} else if (reconciled.disposition === 'failed') {
				this.observers.fail(submission.submissionId, reconciled.error);
			}
		}
	}

	private async startSubmissionAttempt(submission: AgentSubmission): Promise<void> {
		if (submission.status !== 'running' || !submission.attemptId) return;
		const attempt = { submissionId: submission.submissionId, attemptId: submission.attemptId };
		const attemptKey = this.submissionAttemptLocalKey(submission);
		if (this.activeAttempts.has(attemptKey)) return;
		this.assertAgentsDurabilityApi('runFiber');
		this.activeAttempts.add(attemptKey);
		let running: Promise<void>;
		try {
			// Flue's own durable evidence that this attempt started; deleted at
			// settlement. The fiber stash below stays for the SDK's crash replay
			// (onFiberRecovered); the marker is what reconciliation reads.
			await this.submissions.insertAttemptMarker(attempt);
			running = this.instance.runFiber(FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER, async (fiberCtx) => {
				fiberCtx.stash({ submissionId: submission.submissionId, attemptId: submission.attemptId });
				await this.processSubmissionEntry(submission);
			});
		} catch (error) {
			this.activeAttempts.delete(attemptKey);
			await this.deleteAttemptMarkerSafely(attempt);
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
				void this.deleteAttemptMarkerSafely(attempt);
			});
	}

	/**
	 * Delete the attempt marker at settlement. Deletion failures are logged
	 * rather than thrown: a leftover marker only delays reconciliation of
	 * this attempt until the staleness cutoff expires.
	 */
	private async deleteAttemptMarkerSafely(attempt: {
		submissionId: string;
		attemptId: string;
	}): Promise<void> {
		try {
			await this.submissions.deleteAttemptMarker(attempt);
		} catch (error) {
			console.error(
				'[flue:submission-reconciliation]',
				{
					agentName: this.agentName,
					instanceId: this.instance.name,
					submissionId: attempt.submissionId,
					attemptId: attempt.attemptId,
					operation: 'delete_attempt_marker',
					outcome: 'marker_left_until_stale',
				},
				error,
			);
		}
	}

	private submissionAttemptLocalKey(submission: AgentSubmission): string {
		return `${this.instance.ctx.id.toString()}:${submission.attemptId}`;
	}

	private async listActiveAttemptMarkers(): Promise<Set<string>> {
		const keys = new Set<string>();
		for (const marker of await this.submissions.listAttemptMarkers()) {
			if (Date.now() - marker.createdAt > FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS) continue;
			keys.add(`${marker.submissionId}:${marker.attemptId}`);
		}
		return keys;
	}

	private materializeSubmissionConversation(
		input: AgentSubmission['input'],
		agent: Parameters<typeof materializeAgentSubmissionSession>[1],
	): Promise<void> {
		const operation = this.conversationMaterialization.then(async () => {
			await this.ensureConversationWriter();
			const ctx = this.createDurableContext(
				submissionSyntheticRequest(input),
				input.kind === 'dispatch' ? input.dispatchId : undefined,
			);
			await materializeAgentSubmissionSession(ctx, agent, input, this.prepared.attachmentStore);
		});
		this.conversationMaterialization = operation.catch(() => {});
		return operation;
	}

	private async processSubmissionEntry(submission: AgentSubmission): Promise<void> {
		const conversationWriter = await this.ensureConversationWriter();
		await processSubmission({
			submissions: this.submissions,
			submission,
			resolveAgent: (name) => {
				const agent = this.options.agents.find((record) => record.name === name)?.definition;
				if (!agent) throw new Error('[flue] Agent target unavailable during durable processing.');
				return agent;
			},
			createContext: (dispatchId) =>
				this.createDurableContext(submissionSyntheticRequest(submission.input), dispatchId),
			observers: this.observers,
			conversationWriter,
			onInteractionStart: this.options.onInteractionStart,
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
		waitForResult?: boolean,
		traceCarrier?: FlueTraceCarrier,
	) {
		waitForResult ??= true;
		const input = createDirectAgentSubmissionInput({
			agent: this.agentName,
			id: this.instance.name,
			payload,
			traceCarrier,
		});
		const attachment = this.observers.attach(input.submissionId, { onEvent });
		try {
			const agent = this.options.agents.find((record) => record.name === this.agentName)?.definition;
			if (!agent) throw new Error('[flue] Agent target unavailable during durable admission.');
			const admitted = await this.submissions.admitDirect(input);
			if (admitted.canonicalReadyAt === null) {
				try {
					await this.materializeSubmissionConversation(input, agent);
					await this.submissions.markSubmissionCanonicalReady(input.submissionId);
				} catch (error) {
					throw error;
				}
			}
			const offset = (await this.ensureConversationWriter()).offset;
			await this.armSubmissionWake();
			await this.reconcileSubmissions({ driverAlreadyArmed: true });
			if (!waitForResult) return { submissionId: input.submissionId, offset };
			return { submissionId: input.submissionId, offset, result: await attachment.completion };
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
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.definition;
		if (!agent) return new Response('Dispatch target unavailable.', { status: 404 });
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
		if (admission.submission.canonicalReadyAt === null) {
			try {
				await this.materializeSubmissionConversation(
					{ ...input, kind: 'dispatch', submissionId: input.dispatchId },
					agent,
				);
				const ready = await this.submissions.markSubmissionCanonicalReady(input.dispatchId);
				if (!ready) throw new Error('[flue] Dispatch admission disappeared before canonical readiness.');
			} catch (error) {
				throw error;
			}
		}
		await this.armSubmissionWake();
		await this.reconcileSubmissions({ driverAlreadyArmed: true });
		return Response.json({
			dispatchId: admission.submission.submissionId,
			acceptedAt: input.acceptedAt,
		});
	}
}

function submissionAttemptMarkerKey(submission: AgentSubmission): string {
	return `${submission.submissionId}:${submission.attemptId}`;
}

function isInternalDispatchRequest(request: Request): boolean {
	return (
		request.method === 'POST' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH
	);
}
