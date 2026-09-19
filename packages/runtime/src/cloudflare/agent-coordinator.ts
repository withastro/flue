import { SUBMISSION_HARNESS_NAME, SUBMISSION_SESSION_NAME } from '../adapter-helpers.ts';
import type { AgentSubmission, AgentSubmissionStore } from '../agent-execution-store.ts';
import type { FlueContextInternal } from '../client.ts';
import { ConversationRecordWriter } from '../conversation-writer.ts';
import {
	AgentInstanceExistsError,
	AgentInstanceNotFoundError,
	classifyError,
	InvalidRequestError,
	SubmissionAbortedError,
	SubmissionConflictError,
	SubmissionTimeoutError,
} from '../errors.ts';
import { interceptExecution } from '../execution-interceptor.ts';
import { createMcpConnectionCache } from '../mcp.ts';
import {
	type AttachedAgentSubmissionOptions,
	admitInstanceContact,
	adoptKeyedSubmissionReplay,
	type createAgentSubmissionSessionHandler,
	createDirectAgentSubmissionInput,
	createDispatchAgentSubmissionInput,
	ensureInstanceIdentity,
	finalizePendingSettlement,
	type InstanceContactAdmission,
	type InstanceIdentity,
	isInstanceContactRejection,
	materializeSubmissionAttachments,
	processSubmission,
	reconcileInterruptedSubmission,
	serializeSubmissionError,
	settleUnclaimableSubmission,
	submissionSyntheticRequest,
	unreadySubmissionDeadline,
} from '../runtime/agent-submissions.ts';
import type { AttachmentStore } from '../runtime/attachment-store.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';
import {
	type CoordinatorEventEmitter,
	createCoordinatorEventEmitter,
	drainGlobalEventDeliveries,
} from '../runtime/events.ts';
import { assertAgentDispatchAdmissionInput, handleAgentRequest } from '../runtime/handle-agent.ts';
import {
	handleAgentAttachmentRead,
	handleAgentConversationHead,
	handleAgentConversationRead,
} from '../runtime/handle-conversation-routes.ts';
import { generateAttemptId, isKeyDerivedSubmissionId } from '../runtime/ids.ts';
import { agentStreamPath } from '../runtime/stream-offsets.ts';
import { createSessionStorageKey } from '../session-identity.ts';
import type { DeliveredMessage } from '../types.ts';
import {
	createSqlAgentExecutionStore,
	createSqlConversationStores,
} from './agent-execution-store.ts';

export const CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH = '/__flue/internal/dispatch';
export const CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH = '/__flue/internal/instance-info';

/**
 * The one durable state machine that runs a conversation: an `idle` phase
 * that waits on the mailbox for a submission or an abort, and a `turn` phase
 * that processes one claimed submission to settlement. The run's address is
 * fixed per conversation, it is never expected to complete, and the
 * submission ledger stays the record of what was accepted and how it
 * settled; the machine is its executor.
 */
export const FLUE_CONVERSATION_TASK = 'flue:conversation@v1';
const FLUE_CONVERSATION_RUN_ID = 'flue:conversation';
/** How often a live turn refreshes the engine's transition watchdog. */
const TURN_HEARTBEAT_MS = 30_000;

/** Backoff between idle passes that found unsettled work nothing could claim yet. */
function deferralBackoffMs(deferrals: number): number {
	return Math.min(60_000, 1_000 * 2 ** Math.min(deferrals, 6));
}

type ConversationState =
	| { readonly phase: 'idle'; readonly deferrals: number }
	| { readonly phase: 'turn'; readonly submissionId: string; readonly attemptId: string };

const IDLE: ConversationState = { phase: 'idle', deferrals: 0 };

import type { SqlStorage } from '../sql-storage.ts';

interface CloudflareAgentStorage {
	sql?: SqlStorage;
	transactionSync?<T>(closure: () => T): T;
}

type CloudflareTaskRunState =
	| 'pending'
	| 'running'
	| 'waiting'
	| 'completed'
	| 'failed'
	| 'cancelled';

/** The slice of the Agents SDK `Tasks` capability this coordinator uses. */
interface CloudflareAgentTasks {
	run(
		definition: string,
		input: unknown,
		options: { runId: string },
	): Promise<{ accepted: boolean; state: CloudflareTaskRunState }>;
	send(
		runId: string,
		payload: unknown,
		options: { kind: string; requestId: string },
	): Promise<{ accepted: boolean }>;
	reopen(runId: string): Promise<boolean>;
}

interface CloudflareAgentInstance {
	readonly name: string;
	readonly env: Record<string, unknown>;
	readonly ctx: {
		readonly id: { toString(): string };
		readonly storage: CloudflareAgentStorage;
		/**
		 * DurableObjectState.waitUntil. Optional because test fakes may omit
		 * it; it only tells the platform that fire-and-forget event delivery
		 * left behind by an invocation is deliberate.
		 */
		waitUntil?(promise: Promise<unknown>): void;
	};
	readonly tasks: CloudflareAgentTasks;
}

/** The slice of the Agents SDK machine context the conversation's phases use. */
export interface CloudflareMachineContext {
	/** Aborts for the whole invocation: on `cancel()` and when the watchdog fires. */
	readonly signal: AbortSignal;
	/** The abort mark inside `onCancel`; null in a phase handler. */
	readonly cancelling: string | null;
	receiveAll(filter?: { within?: number }): Promise<unknown>;
	peekAll(): ReadonlyArray<{ readonly key: string }>;
	withdraw(key: string): boolean;
	heartbeat(): void;
	aborted(reason?: string): unknown;
}

/** The machine definition the generated agent class declares for the conversation. */
export interface CloudflareConversationDefinition {
	readonly initial: ConversationState;
	readonly phases: {
		readonly idle: (state: ConversationState, ctx: CloudflareMachineContext) => Promise<unknown>;
		readonly turn: (state: ConversationState, ctx: CloudflareMachineContext) => Promise<unknown>;
	};
	readonly onCancel: (state: ConversationState, ctx: CloudflareMachineContext) => Promise<unknown>;
}

interface CloudflareAgentPreparedCoordinator {
	readonly agentName: string;
	readonly submissionStore: AgentSubmissionStore;
	readonly conversationStreamStore: ConversationStreamStore;
	readonly attachmentStore: AttachmentStore;
}

interface CloudflareAgentRuntimeOptions {
	readonly agents: ReadonlyArray<{
		readonly name: string;
		readonly agent: Parameters<typeof createAgentSubmissionSessionHandler>[0];
	}>;
	readonly createContext: (options: {
		readonly submissionStore: AgentSubmissionStore;
		readonly instance: CloudflareAgentInstance;
		readonly agentName: string;
		readonly request: Request;
		readonly submissionId?: string;
	}) => FlueContextInternal;
	readonly runWithInstanceContext: <T>(
		instance: CloudflareAgentInstance,
		agentName: string,
		callback: () => T,
	) => T;
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
	/**
	 * The conversation machine the generated class declares under
	 * `FLUE_CONVERSATION_TASK`: its `idle` phase waits for work and claims
	 * one submission, its `turn` phase processes it to settlement, and its
	 * `onCancel` abandons a hung turn to the ledger's reconciliation.
	 */
	conversationDefinition(instance: CloudflareAgentInstance): CloudflareConversationDefinition;
	/**
	 * The SDK recorded a terminal failure of the conversation run — a fault,
	 * a missing definition after a deploy. The ledger still holds unsettled
	 * work: bring the run back and wake it so the idle pass reconciles.
	 */
	/**
	 * The SDK recorded a terminal Task failure without running (or over) a
	 * handler — a deadline, an exhausted budget, a missing definition. The
	 * submission row it owned is still unsettled: ensure a drive run so the
	 * reconcile pass settles it from evidence.
	 */
	onTaskError(instance: CloudflareAgentInstance, error: unknown): Promise<void>;
	onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
	/**
	 * Run the Agents SDK alarm handler inside the instance context. Alarms
	 * dispatch `schedule`/`scheduleEvery`/`queue` callbacks to methods on the
	 * (possibly extension-authored) class, so this is the boundary that gives
	 * user scheduled callbacks `getCloudflareContext()` and
	 * `getDurableObjectIdentity()`.
	 */
	onAlarm(
		instance: CloudflareAgentInstance,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
}

export function createCloudflareAgentRuntime(
	options: CloudflareAgentRuntimeOptions,
): CloudflareAgentRuntime {
	const coordinators = new WeakMap<CloudflareAgentInstance, CloudflareAgentCoordinator>();

	const getCoordinator = (instance: CloudflareAgentInstance): CloudflareAgentCoordinator => {
		const coordinator = coordinators.get(instance);
		if (!coordinator) {
			throw new Error('[flue] Generated Cloudflare agent coordinator was not initialized.');
		}
		return coordinator;
	};

	return {
		prepare({ storage, className, agentName }) {
			const submissionStore = createSqlAgentExecutionStore(storage, className);
			const conversationStores = createSqlConversationStores(storage, className);
			return {
				agentName,
				submissionStore,
				...conversationStores,
			};
		},
		attach(instance, prepared) {
			coordinators.set(instance, new CloudflareAgentCoordinator(instance, prepared, options));
		},
		onStart(instance, inherited) {
			return getCoordinator(instance).onStart(inherited);
		},
		conversationDefinition(instance) {
			// Declared from the generated class's field initializer, which runs
			// before `attach` — so the coordinator is looked up when a phase
			// runs, never when the definition is built.
			return {
				initial: IDLE,
				phases: {
					idle: (state, ctx) => getCoordinator(instance).idle(state, ctx),
					turn: (state, ctx) => getCoordinator(instance).turn(state, ctx),
				},
				onCancel: (state, ctx) => getCoordinator(instance).onCancel(state, ctx),
			};
		},
		onTaskError(instance, error) {
			return getCoordinator(instance).onTaskError(error);
		},
		onRequest(instance, request) {
			return getCoordinator(instance).onRequest(request);
		},
		onAlarm(instance, inherited) {
			return getCoordinator(instance).onAlarm(inherited);
		},
	};
}

class CloudflareAgentCoordinator {
	constructor(
		private readonly instance: CloudflareAgentInstance,
		private readonly prepared: CloudflareAgentPreparedCoordinator,
		private readonly options: CloudflareAgentRuntimeOptions,
	) {
		this.emitCoordinatorEvent = createCoordinatorEventEmitter({
			agentName: prepared.agentName,
			instanceId: instance.name,
			env: instance.env,
		});
	}

	private conversationWriter: ConversationRecordWriter | undefined;
	private conversationWriterCreation: Promise<ConversationRecordWriter> | undefined;
	private conversationMaterialization: Promise<void> = Promise.resolve();
	/**
	 * Context-free live event emitter for coordinator signals
	 * (`submission_queued`, `submission_recovery`, recovered settlements) —
	 * independent of context/writer creation, which is among the failures it
	 * reports, and infallible by contract so it can never worsen a recovery
	 * catch block.
	 */
	private readonly emitCoordinatorEvent: CoordinatorEventEmitter;
	/**
	 * Live MCP connections for this instance (one DO = one agent instance).
	 * Submissions reuse them while the isolate stays warm; eviction is the
	 * teardown — a DO has no disposal hook, and streamable HTTP holds no
	 * server state worth a farewell.
	 */
	private readonly mcpConnections = createMcpConnectionCache();
	/**
	 * Abort controllers for attempts live in this isolate, keyed by
	 * submissionId, so an incoming cancel request can abort the running
	 * attempt. The DO is single-threaded but interleaves at `await` points,
	 * so a cancel request can fire the controller while the attempt is
	 * suspended on provider I/O. If the isolate is evicted the controller is
	 * gone and the abort falls back to the durable `abortRequestedAt` +
	 * reconcile path.
	 */
	private activeControllers = new Map<string, AbortController>();
	/**
	 * Attempt ids this isolate claimed and handed to an attempt run that has
	 * not yet entered its handler body. The run's first execution takes the
	 * id out and processes the claim as-is; a body that finds no entry is a
	 * replay on a fresh isolate (or after its previous execution ended) and
	 * must reconcile the row from durable evidence before doing anything.
	 */
	private readonly startedAttempts = new Set<string>();

	// Instance context is established at the boundaries where execution
	// enters the Durable Object: onStart, onRequest, onAlarm, and the two
	// Task handler bodies (drive, attempt). A Task handler may run on a fresh
	// isolate with no ambient context, so each body (re)establishes it.
	// onAlarm wraps the Agents SDK alarm handler, covering every scheduled
	// callback it dispatches — including extension-authored
	// schedule/scheduleEvery/queue targets (#437). Everything reachable from
	// these boundaries — dispatch admission, reconciliation, materialization,
	// submission processing — assumes the context is already present and
	// never re-wraps.
	//
	// Execution ownership: attempts start ONLY from the drive run's
	// reconcile pass, each as its own `flue:attempt@v1` Task run whose
	// handler body awaits the submission to settlement. The Agents SDK owns
	// the durable wake (a claim backstop while the run is held, a replay on
	// a fresh isolate after an interruption), the deadline (the submission's
	// durability timeout, settled over a hung attempt with its later writes
	// fenced out), and the attempt-wide abort signal. All other boundaries
	// (admission, abort, onStart, Task failures) record durable intent and
	// ensure the drive run exists; joining an existing one is free.
	onStart(inherited: () => Promise<unknown> | unknown): Promise<void> {
		return this.runWithInstanceContext(async () => {
			await this.wakeIfUnsettled('start');
			await inherited();
		});
	}
	/**
	 * Wait for work, then claim one submission. Mailbox items are wakes, not
	 * the queue: the ledger decides what runs next, so every item is taken
	 * and discarded before the ledger is read. With nothing unsettled the run
	 * parks with no alarm at all; with unsettled work nothing can claim yet
	 * — a materialization deferred, a settlement pending — it parks on a
	 * growing backoff that any send cuts short.
	 */
	idle(state: ConversationState, ctx: CloudflareMachineContext): Promise<ConversationState> {
		return this.runWithInstanceContext(async () => {
			for (const item of ctx.peekAll()) ctx.withdraw(item.key);
			if (!(await this.submissions.hasUnsettledSubmissions())) {
				await ctx.receiveAll();
				return IDLE;
			}
			const claims = await interceptExecution(
				{ type: 'coordinator', phase: 'reconcile' },
				{ instanceId: this.instance.name, agentName: this.agentName },
				() => this.reconcileSubmissions(),
			);
			this.instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			const head = claims[0];
			if (head?.attemptId) {
				this.startedAttempts.add(head.attemptId);
				return { phase: 'turn' as const, submissionId: head.submissionId, attemptId: head.attemptId };
			}
			const deferrals = state.phase === 'idle' ? state.deferrals + 1 : 1;
			await ctx.receiveAll({ within: deferralBackoffMs(deferrals) });
			return { phase: 'idle' as const, deferrals };
		});
	}
	/**
	 * Process the claimed submission to settlement. The claim was made by the
	 * idle pass in this isolate; a turn re-dispatched without that memory is
	 * a replay after an interruption, and the ledger and canonical stream
	 * decide whether the submission settled, needs a replacement attempt, or
	 * is spent.
	 */
	turn(state: ConversationState, ctx: CloudflareMachineContext): Promise<ConversationState> {
		return this.runWithInstanceContext(async () => {
			if (state.phase !== 'turn') return IDLE;
			const row = await this.submissions.getSubmission(state.submissionId);
			if (row?.status !== 'running' || row.attemptId !== state.attemptId) return IDLE;
			if (!this.startedAttempts.delete(state.attemptId)) {
				const replacement = await this.reconcileInterruptedSubmission(row);
				if (!replacement?.attemptId) return IDLE;
				this.startedAttempts.add(replacement.attemptId);
				return {
					phase: 'turn' as const,
					submissionId: replacement.submissionId,
					attemptId: replacement.attemptId,
				};
			}
			await this.runAttempt(row, ctx);
			return IDLE;
		});
	}
	/**
	 * The abort protocol reached the conversation. A cancel of the run itself
	 * ends it; the transition watchdog or the memory breaker interrupting a
	 * hung turn abandons that attempt — its controller aborted, its writer
	 * rotated so a zombie's appends are refused — and the machine resumes at
	 * `idle`, where the ledger reconciles the abandoned attempt.
	 */
	onCancel(state: ConversationState, ctx: CloudflareMachineContext): Promise<unknown> {
		return this.runWithInstanceContext(async () => {
			if (state.phase === 'turn') {
				const controller = this.activeControllers.get(state.submissionId);
				if (controller) {
					controller.abort(
						ctx.cancelling === 'cancel' ? new SubmissionAbortedError() : new SubmissionTimeoutError(),
					);
					this.orphanEnforcedAttempt(state.submissionId, controller);
				}
			}
			if (ctx.cancelling === 'cancel' || ctx.cancelling === 'seal') {
				return ctx.aborted(ctx.cancelling);
			}
			return IDLE;
		});
	}
	private async runAttempt(submission: AgentSubmission, ctx: CloudflareMachineContext): Promise<void> {
		const controller = new AbortController();
		this.activeControllers.set(submission.submissionId, controller);
		const onRunAbort = () => controller.abort(submissionAbortReason(ctx.signal.reason));
		if (ctx.signal.aborted) onRunAbort();
		else ctx.signal.addEventListener('abort', onRunAbort, { once: true });
		const deadline = submission.timeoutAt > 0 ? submission.timeoutAt : undefined;
		const deadlineTimer =
			deadline === undefined
				? undefined
				: setTimeout(
						() => controller.abort(new SubmissionTimeoutError()),
						Math.max(0, deadline - Date.now()),
					);
		// The engine's transition watchdog is the safety net for a turn that
		// hangs past its own timeout; until then, a live turn keeps it fed.
		const heartbeat = setInterval(() => {
			if (deadline !== undefined && Date.now() >= deadline) return;
			ctx.heartbeat();
		}, TURN_HEARTBEAT_MS);
		try {
			await this.processSubmissionEntry(submission, controller.signal);
		} finally {
			clearInterval(heartbeat);
			if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
			ctx.signal.removeEventListener('abort', onRunAbort);
			this.deleteControllerIfCurrent(submission.submissionId, controller);
			this.instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
		}
	}
	onTaskError(error: unknown): Promise<void> {
		return this.runWithInstanceContext(async () => {
			if (!isTaskRecordedFailure(error)) return;
			await this.wakeIfUnsettled('recover');
		});
	}
	onRequest(request: Request): Promise<Response | null> {
		return this.runWithInstanceContext(async () => {
			try {
				return await this.routeRequest(request);
			} finally {
				// Admission-side observe() emissions (submission_queued, abort
				// advisories) must survive the request invocation ending.
				this.instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
			}
		});
	}

	async onAlarm(inherited: () => Promise<unknown> | unknown): Promise<unknown> {
		return this.runWithInstanceContext(() => inherited());
	}

	private async routeRequest(request: Request): Promise<Response | null> {
		if (isInternalDispatchRequest(request)) return this.admitDispatch(request);
		if (isInternalInstanceInfoRequest(request)) return this.instanceInfo();

		if (isAbortRequest(request, this.agentName, this.instance.name)) {
			const aborted = await this.abortInstance();
			return Response.json({ aborted });
		}

		const method = request.method;
		if (method === 'GET' || method === 'HEAD') {
			const streamPath = agentStreamPath(this.agentName, this.instance.name);
			// Attachment byte download. The outer Worker has already run the
			// module's `route` middleware, only forwards GET, and rewrites the
			// request onto the canonical `/agents/<name>/<id>/attachments/<id>`
			// path whatever the public mount looks like — so the DO, which owns
			// the bytes, just serves from its attachment store. Match the exact
			// tail (not a loose `/attachments/` substring) so an agent literally
			// named "attachments" doesn't misroute its conversation reads here.
			const segments = new URL(request.url).pathname.split('/');
			const attachmentId =
				method === 'GET' &&
				segments.length >= 4 &&
				segments[segments.length - 2] === 'attachments' &&
				segments[segments.length - 3] === this.instance.name &&
				segments[segments.length - 4] === this.agentName
					? decodeURIComponent(segments[segments.length - 1] as string)
					: undefined;
			if (attachmentId) {
				return handleAgentAttachmentRead({
					conversationStore: this.prepared.conversationStreamStore,
					attachmentStore: this.prepared.attachmentStore,
					path: streamPath,
					attachmentId: decodeURIComponent(attachmentId),
				});
			}
			if (method === 'HEAD') {
				return await handleAgentConversationHead(this.prepared.conversationStreamStore, streamPath);
			}
			return handleAgentConversationRead({
				store: this.prepared.conversationStreamStore,
				path: streamPath,
				request,
			});
		}

		return handleAgentRequest({
			request,
			id: this.instance.name,
			agentName: this.agentName,
			admitAttachedSubmission: (message, options) => this.admitAttachedSubmission(message, options),
		});
	}

	private get agentName(): string {
		return this.prepared.agentName;
	}

	private get submissions(): AgentSubmissionStore {
		return this.prepared.submissionStore;
	}

	private runWithInstanceContext<T>(callback: () => T): T {
		return this.options.runWithInstanceContext(this.instance, this.agentName, callback);
	}

	private async ensureConversationWriter(): Promise<ConversationRecordWriter> {
		if (this.conversationWriter && !this.conversationWriter.failed) return this.conversationWriter;
		if (!this.conversationWriterCreation) {
			const creation = ConversationRecordWriter.create({
				store: this.prepared.conversationStreamStore,
				path: agentStreamPath(this.agentName, this.instance.name),
				identity: { agentName: this.agentName, instanceId: this.instance.name },
				producerId: this.instance.ctx.id.toString(),
				onFailed: (writer) => {
					if (this.conversationWriter === writer) this.conversationWriter = undefined;
				},
			});
			this.conversationWriterCreation = creation;
			void creation.then(
				(writer) => {
					if (!writer.failed) this.conversationWriter = writer;
					if (this.conversationWriterCreation === creation)
						this.conversationWriterCreation = undefined;
				},
				() => {
					if (this.conversationWriterCreation === creation)
						this.conversationWriterCreation = undefined;
				},
			);
		}
		return this.conversationWriterCreation;
	}

	private createContext(request: Request, submissionId?: string): FlueContextInternal {
		return this.options.createContext({
			submissionStore: this.submissions,
			instance: this.instance,
			agentName: this.agentName,
			request,
			submissionId,
		});
	}

	private createDurableContext(request: Request, submissionId?: string): FlueContextInternal {
		const ctx = this.createContext(request, submissionId);
		ctx.setConversationWriter?.(this.conversationWriter);
		ctx.setAttachmentStore?.(this.prepared.attachmentStore);
		ctx.setMcpConnections?.(this.mcpConnections);
		return ctx;
	}

	private get tasks(): CloudflareAgentTasks {
		const tasks = this.instance.tasks;
		if (!tasks || typeof tasks.run !== 'function') {
			throw new Error(
				'[flue] The installed "agents" package does not provide the Cloudflare Agents SDK Tasks capability on Agent. Upgrade @flue/vite (which supplies the Cloudflare Agents SDK), or remove the "agents" dependency from your project if it declares an older one.',
			);
		}
		return tasks;
	}

	/**
	 * The conversation's run: one fixed address, joined when it exists and
	 * brought back to `pending` when a fault ended it, so an admission never
	 * finds a dead executor.
	 */
	private async ensureConversation(): Promise<void> {
		const receipt = await this.tasks.run(FLUE_CONVERSATION_TASK, undefined, {
			runId: FLUE_CONVERSATION_RUN_ID,
		});
		if (!receipt.accepted && (receipt.state === 'failed' || receipt.state === 'cancelled')) {
			await this.tasks.reopen(FLUE_CONVERSATION_RUN_ID);
		}
	}
	/** Wake the conversation: one mailbox item, deduplicated by its key. */
	private async wake(kind: 'submission' | 'abort' | 'wake', key: string): Promise<void> {
		await this.ensureConversation();
		await this.tasks.send(
			FLUE_CONVERSATION_RUN_ID,
			{ kind, key },
			{ kind, requestId: `${kind}:${key}` },
		);
	}
	private async wakeIfUnsettled(reason: string): Promise<boolean> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return false;
		await this.wake('wake', `${reason}:${Date.now()}`);
		return true;
	}
	/**
	 * One reconcile pass: materialize unready submissions, finalize pending
	 * settlements, recover interrupted attempts, enforce deadlines on live
	 * ones, and claim runnable work. Returns the claims for the supervisor
	 * pass to start — this method never waits on agent execution itself.
	 * Failures are logged with `deferred_to_scheduled_wake` and surface as
	 * still-unsettled work the heartbeat owns.
	 */
	private async reconcileSubmissions(): Promise<ReadonlyArray<AgentSubmission>> {
		const toStart: Array<AgentSubmission> = [];
		if (!(await this.submissions.hasUnsettledSubmissions())) return toStart;
		try {
			for (const submission of await this.submissions.listUnreadySubmissions()) {
				// A durable abort on an unready row settles here: the row is never
				// claimable, so the attempt-based abort settle can never run — this
				// is the guaranteed escape hatch for every stuck-unready class.
				if (submission.abortRequestedAt !== undefined) {
					await settleUnclaimableSubmission(
						this.submissions,
						submission,
						'aborted',
						new SubmissionAbortedError(),
						this.emitCoordinatorEvent,
					);
					continue;
				}
				const found = this.options.agents.find(
					(record) => record.name === submission.input.agent,
				)?.agent;
				const agent =
					found &&
					submission.input.agent === this.agentName &&
					submission.input.id === this.instance.name
						? found
						: undefined;
				if (!agent) {
					if (
						Date.now() >= unreadySubmissionDeadline(submission, undefined) &&
						(await this.terminalizeUnreadySubmission(
							submission,
							new Error(
								`[flue] Submission target agent "${submission.input.agent}" has no registered definition, so the submission could never start.`,
							),
						))
					) {
						continue;
					}
					console.error('[flue:submission-reconciliation]', {
						agentName: this.agentName,
						instanceId: this.instance.name,
						submissionId: submission.submissionId,
						sessionKey: submission.sessionKey,
						operation: 'materialize_submission',
						outcome: 'agent_unavailable',
					});
					this.emitCoordinatorEvent({
						type: 'submission_recovery',
						submissionId: submission.submissionId,
						kind: submission.kind,
						operation: 'materialize_submission',
						outcome: 'agent_unavailable',
					});
					continue;
				}
				try {
					await this.materializeSubmissionConversation(submission.input, agent);
					await this.submissions.markSubmissionCanonicalReady(submission.submissionId);
				} catch (error) {
					if (
						Date.now() >= unreadySubmissionDeadline(submission, agent) &&
						(await this.terminalizeUnreadySubmission(submission, error))
					) {
						continue;
					}
					this.logSubmissionReconciliationFailure(submission, 'materialize_submission', error);
				}
			}
			for (const settlement of await this.submissions.listPendingSubmissionSettlements()) {
				const submission = await this.submissions.getSubmission(settlement.submissionId);
				if (!submission) continue;
				// Per-item isolation, matching the sibling loops: one bad settlement
				// (e.g. a canonical mismatch) must not skip the running-recovery and
				// runnable-claim passes below for the instance's other work.
				try {
					const writer = await this.ensureConversationWriter();
					await finalizePendingSettlement(
						this.submissions,
						writer,
						settlement,
						this.emitCoordinatorEvent,
					);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, 'finalize_settlement', error);
				}
			}
			for (const submission of await this.submissions.listRunningSubmissions()) {
				// A running row whose attempt run the SDK still holds belongs to
				// that run: it is either live in this isolate, or interrupted and
				// due for the SDK's replay, whose handler body reconciles it.
				// Reconciling here too would race that replay for the claim.
				// A running row with NO attempt run is this pass's to recover:
				// the run settled over a hung attempt (its deadline), failed
				// without running (definition missing), or the claim-to-start
				// gap was preempted. When the hung attempt is still live here it
				// is signaled and orphaned first, so its late writes lose the
				// settlement CAS and attempt-id fences and it can no longer
				// append through the shared writer.
				try {
					const liveController = this.activeControllers.get(submission.submissionId);
					if (liveController) {
						liveController.abort(
							submission.abortRequestedAt !== undefined
								? new SubmissionAbortedError()
								: new SubmissionTimeoutError(),
						);
						console.error('[flue:submission-reconciliation]', {
							agentName: this.agentName,
							instanceId: this.instance.name,
							submissionId: submission.submissionId,
							sessionKey: submission.sessionKey,
							attemptId: submission.attemptId,
							operation: 'enforce_deadline',
							outcome: 'terminated',
							reason:
								submission.abortRequestedAt !== undefined ? 'abort_unhonored' : 'exceeded_timeout',
						});
					}
					const replacement = await this.reconcileInterruptedSubmission(submission);
					// The attempt run starts after the reconcile pass returns —
					// see drive for why starts must escape the pass's tracing
					// activation.
					if (replacement) toStart.push(replacement);
					if (liveController) this.orphanEnforcedAttempt(submission.submissionId, liveController);
				} catch (error) {
					this.logSubmissionReconciliationFailure(submission, 'reconcile_submission', error);
				}
			}
			// One turn at a time: the first runnable head is claimed; the rest
			// wait for the idle pass that follows this turn.
			if (toStart.length === 0) {
				for (const submission of await this.submissions.listRunnableSubmissions()) {
					const claimed = await this.submissions.claimSubmission({
						submissionId: submission.submissionId,
						attemptId: generateAttemptId(),
						ownerId: this.instance.ctx.id.toString(),
						leaseExpiresAt: 0,
					});
					if (claimed) {
						toStart.push(claimed);
						break;
					}
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
			this.emitCoordinatorEvent(
				{
					type: 'submission_recovery',
					operation: 'reconcile_pass',
					outcome: 'deferred',
					error: serializeSubmissionError(error),
				},
				{ errorInfo: classifyError(error) },
			);
		}
		return toStart;
	}

	/**
	 * Auto-fail a queued row whose materialization can never succeed, past its
	 * admission-anchored durability bound (see `unreadySubmissionDeadline`).
	 * Returns whether this coordinator won the terminal transition — a `false`
	 * (another isolate settled first, or a racing claim made the row runnable)
	 * falls back to the deferral logging so nothing is silently dropped.
	 */
	private async terminalizeUnreadySubmission(
		submission: AgentSubmission,
		error: unknown,
	): Promise<boolean> {
		const settled = await settleUnclaimableSubmission(
			this.submissions,
			submission,
			'failed',
			error,
			this.emitCoordinatorEvent,
		);
		if (!settled) return false;
		console.error(
			'[flue:submission-reconciliation]',
			{
				agentName: this.agentName,
				instanceId: this.instance.name,
				submissionId: submission.submissionId,
				sessionKey: submission.sessionKey,
				operation: 'materialize_submission',
				outcome: 'terminated',
			},
			error,
		);
		return true;
	}

	private logSubmissionReconciliationFailure(
		submission: AgentSubmission,
		operation:
			| 'materialize_submission'
			| 'finalize_settlement'
			| 'reconcile_submission'
			| 'start_submission',
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
		this.emitCoordinatorEvent(
			{
				type: 'submission_recovery',
				submissionId: submission.submissionId,
				kind: submission.kind,
				operation,
				outcome: 'deferred',
				attemptCount: submission.attemptCount,
				maxAttempts: submission.maxAttempts,
				error: serializeSubmissionError(error),
			},
			{ errorInfo: classifyError(error) },
		);
	}

	/**
	 * Recover one interrupted attempt. Returns the claimed replacement
	 * submission (if recovery produced one) for the caller's reconcile pass
	 * to start — attempts start only through the drain's guarded path.
	 */
	private async reconcileInterruptedSubmission(
		submission: AgentSubmission,
	): Promise<AgentSubmission | undefined> {
		const conversationWriter = await this.ensureConversationWriter();
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.agent;
		if (!agent) throw new Error('[flue] Agent target unavailable during durable reconciliation.');
		const replacement = await reconcileInterruptedSubmission(
			this.submissions,
			submission,
			agent,
			(submissionId) =>
				this.createDurableContext(submissionSyntheticRequest(submission.input), submissionId),
			{ ownerId: this.instance.ctx.id.toString(), leaseExpiresAt: 0 },
			conversationWriter,
			this.emitCoordinatorEvent,
		);
		return replacement ?? undefined;
	}

	/**
	 * Controllers are keyed by submissionId and shared across attempts, so a
	 * late cleanup from a superseded attempt (its body settling after a
	 * replacement attempt already registered its own controller) must not
	 * delete the replacement's controller — that would sever the abort path
	 * for a live attempt.
	 */
	private deleteControllerIfCurrent(submissionId: string, controller: AbortController): void {
		if (this.activeControllers.get(submissionId) === controller) {
			this.activeControllers.delete(submissionId);
		}
	}

	/**
	 * After the reconcile pass settled over a live-but-hung attempt, orphan
	 * it: drop its controller entry (its own finally-cleanup is unreachable)
	 * and rotate the cached conversation writer so later sessions acquire a
	 * fresh producer — a waking zombie's rejected append then fails only the
	 * stale writer object it holds, never a successor's.
	 */
	private orphanEnforcedAttempt(submissionId: string, controller: AbortController): void {
		this.deleteControllerIfCurrent(submissionId, controller);
		this.conversationWriter = undefined;
		this.conversationWriterCreation = undefined;
	}

	async abortInstance(): Promise<boolean> {
		// One DO instance owns one agent instance; external submissions share one
		// durable session, so a single session-scoped stamp covers the running
		// head and every queued submission behind it.
		const sessionKey = createSessionStorageKey(
			this.agentName,
			this.instance.name,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		);
		const affected = await this.submissions.requestSessionAbort(sessionKey);
		if (affected.length === 0) return false;
		// Abort any of those attempts live in this isolate —
		// processSubmission's catch settles them aborted and the attempt body
		// ensures the next drive. Queued ones settle via the pre-execution
		// abort check once a drive claims them; an evicted running attempt is
		// driven by the durable flag through reconciliation, and a signal-deaf
		// live attempt is settled over by its run deadline (the submission's
		// durability timeout), after which the drive reconciles it aborted.
		for (const submissionId of affected) {
			this.activeControllers.get(submissionId)?.abort(new SubmissionAbortedError());
			await this.wake('abort', submissionId);
		}
		return true;
	}

	/**
	 * Admission-side materialization, serialized per instance: ensure the
	 * birth record (find-or-create, no render, no sandbox) and persist the
	 * message's attachments under its conversation id. Idempotent — admission,
	 * replays, and the unready-row recovery pass all run it safely. Returns
	 * the identity for the receipt.
	 */
	private materializeSubmissionConversation(
		input: AgentSubmission['input'],
		agent: Parameters<typeof createAgentSubmissionSessionHandler>[0],
	): Promise<InstanceIdentity> {
		const operation = this.conversationMaterialization.then(async () => {
			const writer = await this.ensureConversationWriter();
			const identity = await ensureInstanceIdentity(writer, agent, input.initialData);
			await materializeSubmissionAttachments(
				input,
				identity.conversationId,
				this.prepared.attachmentStore,
			);
			return identity;
		});
		this.conversationMaterialization = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private async processSubmissionEntry(
		submission: AgentSubmission,
		signal?: AbortSignal,
	): Promise<void> {
		const conversationWriter = await this.ensureConversationWriter();
		await processSubmission({
			submissions: this.submissions,
			submission,
			resolveAgent: (name) => {
				const agent = this.options.agents.find((record) => record.name === name)?.agent;
				if (!agent) throw new Error('[flue] Agent target unavailable during durable processing.');
				return agent;
			},
			createContext: (submissionId) =>
				this.createDurableContext(submissionSyntheticRequest(submission.input), submissionId),
			conversationWriter,
			emitCoordinatorEvent: this.emitCoordinatorEvent,
			signal,
		});
	}

	private async admitAttachedSubmission(
		message: DeliveredMessage,
		options: AttachedAgentSubmissionOptions = {},
	) {
		const { traceCarrier, initialData, uid, idempotencyKey } = options;
		const input = await createDirectAgentSubmissionInput({
			agent: this.agentName,
			id: this.instance.name,
			message,
			initialData,
			traceCarrier,
			...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
		});
		const keyed = idempotencyKey !== undefined;
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.agent;
		if (!agent) throw new Error('[flue] Agent target unavailable during durable admission.');
		const loadReducedState = async () => (await this.ensureConversationWriter()).loadReducedState();
		// A deduplicated replay re-attaches from the stream origin: the original
		// admission-time offset is not persisted, and settlement records are
		// observable from the origin indefinitely.
		const adoptedReceipt = async (submissionId: string) => {
			const reducedUid = (await loadReducedState()).uid;
			if (reducedUid === undefined) return undefined;
			await this.wake('submission', submissionId);
			return {
				submissionId,
				offset: '-1',
				uid: reducedUid,
				deduplicated: true as const,
			};
		};
		let contact: InstanceContactAdmission;
		try {
			contact = await admitInstanceContact({
				agent,
				id: this.instance.name,
				initialData,
				uid,
				loadReducedState,
			});
		} catch (error) {
			// Keyed retries can trip their own send condition (a create-only send
			// whose first attempt created the instance): adopt the submission the
			// key already names — the condition was consumed by the original
			// admission. A fresh keyed send keeps today's exact semantics.
			if (keyed && isInstanceContactRejection(error)) {
				const adopted = await adoptKeyedSubmissionReplay(this.submissions, input);
				const receipt = adopted && (await adoptedReceipt(adopted.submissionId));
				if (receipt) return receipt;
			}
			throw error;
		}
		let admitted: AgentSubmission;
		let deduplicated = false;
		try {
			admitted = await this.submissions.admitDirect(input);
		} catch (error) {
			// The store rejects a caller retry byte-exactly (it re-stamps
			// acceptedAt/traceCarrier); a keyed admission converges on identity
			// above the store instead. Adoption only ever swallows the failure
			// when a matching-identity row exists.
			if (!keyed) throw error;
			const adopted = await adoptKeyedSubmissionReplay(this.submissions, input);
			if (!adopted) throw error;
			admitted = adopted;
			deduplicated = true;
		}
		// Live queue signal, emitted immediately after durable admission.
		// At-least-once: admission cannot distinguish an idempotent replay, so
		// replays (keyed dedup included) re-emit.
		this.emitCoordinatorEvent({
			type: 'submission_queued',
			submissionId: admitted.submissionId,
			kind: 'direct',
		});
		// The durable row exists from here on: the drain must be armed even if
		// materialization/readiness/uid below throws, or the queued row would
		// strand with nothing to ever claim it.
		try {
			let identity: InstanceIdentity | undefined;
			if (admitted.canonicalReadyAt === null) {
				identity = await this.materializeSubmissionConversation(input, agent);
				// Tolerate a null return: a concurrent readiness pass may have
				// advanced this row already; null means "already past queued", not
				// a lost submission (rows are never deleted).
				await this.submissions.markSubmissionCanonicalReady(input.submissionId);
			}
			const writer = await this.ensureConversationWriter();
			const offset = deduplicated ? '-1' : writer.offset;
			// An adopted replay may hold neither the contact uid nor a fresh
			// identity (its gate ran before the winning admission materialized) —
			// the birth record is durable by then, so read the identity back.
			let instanceUid = contact.uid ?? identity?.uid;
			if (instanceUid === undefined && deduplicated) {
				instanceUid = (await loadReducedState()).uid;
			}
			if (instanceUid === undefined) {
				throw new Error(
					"[flue] invariant: a materialized instance's birth record must carry a uid.",
				);
			}
			return {
				submissionId: input.submissionId,
				offset,
				uid: instanceUid,
				...(deduplicated ? { deduplicated: true as const } : {}),
			};
		} finally {
			await this.wake('submission', admitted.submissionId);
		}
	}

	/**
	 * Internal instance lookup for `getAgentInstance()`: existence and uid
	 * from this Durable Object's reduced conversation state. Getting a DO
	 * stub implicitly instantiates the object, so existence is judged by the
	 * birth record, never by DO liveness.
	 */
	private async instanceInfo(): Promise<Response> {
		const reduced = await (await this.ensureConversationWriter()).loadReducedState();
		if (reduced.initialData === undefined) return Response.json({ exists: false });
		return Response.json({
			exists: true,
			...(reduced.uid !== undefined ? { uid: reduced.uid } : {}),
		});
	}

	private async admitDispatch(request: Request): Promise<Response> {
		const input: unknown = await request.json();
		assertAgentDispatchAdmissionInput(input);
		if (input.agent !== this.agentName || input.id !== this.instance.name) {
			return new Response('Invalid internal dispatch target.', { status: 400 });
		}
		const agent = this.options.agents.find((record) => record.name === this.agentName)?.agent;
		if (!agent) return new Response('Dispatch target unavailable.', { status: 404 });
		const keyed = isKeyDerivedSubmissionId(input.submissionId);
		const submissionInput = createDispatchAgentSubmissionInput(input);
		const loadReducedState = async () => (await this.ensureConversationWriter()).loadReducedState();
		try {
			let contact: InstanceContactAdmission;
			try {
				contact = await admitInstanceContact({
					agent,
					id: this.instance.name,
					initialData: input.initialData,
					uid: input.uid,
					loadReducedState,
				});
			} catch (error) {
				// Keyed retries can trip their own send condition (a create-only
				// send whose first attempt created the instance): adopt the
				// submission the key already names — the condition was consumed by
				// the original admission — and echo the recorded uid. A fresh
				// keyed send keeps today's exact semantics.
				if (keyed && isInstanceContactRejection(error)) {
					const adopted = await adoptKeyedSubmissionReplay(this.submissions, submissionInput);
					const adoptedUid = adopted ? (await loadReducedState()).uid : undefined;
					if (adopted && adoptedUid !== undefined) {
						await this.wake('submission', adopted.submissionId);
						return Response.json({
							submissionId: adopted.submissionId,
							acceptedAt: adopted.input.acceptedAt,
							uid: adoptedUid,
							deduplicated: true,
						});
					}
				}
				throw error;
			}
			const admission = await this.submissions.admitDispatch(input);
			let submission: AgentSubmission;
			let deduplicated = false;
			if (admission.kind === 'submission') {
				submission = admission.submission;
			} else {
				// The store rejects a caller retry byte-exactly (it re-stamps
				// acceptedAt); a keyed conflict converges on submission identity
				// above the store. Everything else — unkeyed conflicts and keyed
				// divergence — is the structured 409 the Worker side rehydrates.
				const adopted = keyed
					? await adoptKeyedSubmissionReplay(this.submissions, submissionInput)
					: undefined;
				if (!adopted) throw new SubmissionConflictError({ submissionId: input.submissionId });
				submission = adopted;
				deduplicated = true;
			}
			// Live queue signal, emitted immediately after durable admission.
			// At-least-once: admission cannot distinguish an idempotent replay,
			// so replays (keyed dedup included) re-emit.
			this.emitCoordinatorEvent({
				type: 'submission_queued',
				submissionId: submission.submissionId,
				kind: 'dispatch',
			});
			// The durable row exists from here on: the drain must be armed even if
			// materialization/readiness/uid below throws, or the queued row would
			// strand with nothing to ever claim it.
			try {
				let identity: InstanceIdentity | undefined;
				if (submission.canonicalReadyAt === null) {
					identity = await this.materializeSubmissionConversation(submissionInput, agent);
					// Tolerate a null return (see the direct path): a concurrent readiness
					// pass may have advanced this row already; null is not a lost submission.
					await this.submissions.markSubmissionCanonicalReady(input.submissionId);
				}
				// The uid rides every receipt: echoed for a continuing send, minted by
				// materialization's identity ensure for a creating one. An adopted
				// replay may hold neither (its gate ran before the winning admission
				// materialized) — read the recorded identity back instead.
				let uid = contact.uid ?? identity?.uid;
				if (uid === undefined && deduplicated) uid = (await loadReducedState()).uid;
				if (uid === undefined) {
					throw new Error(
						"[flue] invariant: a materialized instance's birth record must carry a uid.",
					);
				}
				return Response.json({
					submissionId: submission.submissionId,
					// The stored row's timestamp, so a deduplicated replay echoes the
					// ORIGINAL admission's receipt (identical on a fresh admission).
					acceptedAt: submission.input.acceptedAt,
					uid,
					...(deduplicated ? { deduplicated: true } : {}),
				});
			} finally {
				await this.wake('submission', submission.submissionId);
			}
		} catch (error) {
			// Structured body so the dispatch() caller's enqueue can rehydrate the
			// typed admission error (`type` selects the class; `uid` restores the
			// instance-exists 409's incarnation field; `submissionId` restores the
			// submission-conflict 409's existing id) with caller-safe details intact.
			if (
				error instanceof InvalidRequestError ||
				error instanceof AgentInstanceNotFoundError ||
				error instanceof AgentInstanceExistsError ||
				error instanceof SubmissionConflictError
			) {
				return Response.json(
					{
						type: error.type,
						error: error.message,
						details: error.details,
						...(error instanceof AgentInstanceExistsError ? { uid: error.uid } : {}),
						...(error instanceof SubmissionConflictError
							? { submissionId: error.submissionId }
							: {}),
					},
					{ status: error.status },
				);
			}
			throw error;
		}
	}
}

/**
 * Translate the Agents SDK's attempt-wide abort reason into the submission
 * error `processSubmission` keys its settlement on: the run deadline is the
 * submission's durability timeout; anything else (an SDK cancellation) is an
 * abort.
 */
function submissionAbortReason(reason: unknown): Error {
	return isTaskError(reason, 'TaskDeadlineExceededError')
		? new SubmissionTimeoutError()
		: new SubmissionAbortedError();
}

/**
 * Whether an error the Agents SDK reported through `onError` is one it
 * recorded against a Task run without (or over) its handler — the cases
 * that leave a running submission row behind with no run to finish it.
 * Matched by name: `@flue/runtime` does not import `agents`.
 */
function isTaskRecordedFailure(error: unknown): boolean {
	return (
		isTaskError(error, 'TaskDeadlineExceededError') ||
		isTaskError(error, 'TaskAttemptsExhaustedError') ||
		isTaskError(error, 'MissingTaskDefinitionError')
	);
}

function isTaskError(error: unknown, name: string): boolean {
	return (
		typeof error === 'object' &&
		error !== null &&
		'name' in error &&
		(error as { name: unknown }).name === name
	);
}

function isInternalDispatchRequest(request: Request): boolean {
	return (
		request.method === 'POST' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH
	);
}

function isInternalInstanceInfoRequest(request: Request): boolean {
	return (
		request.method === 'GET' &&
		new URL(request.url).pathname === CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH
	);
}

/**
 * Whether the request is an abort for this agent instance
 * (`POST .../agents/<name>/<id>/abort`). Matched by exact tail position (not a
 * loose substring) so an agent or instance named "abort" cannot misroute.
 */
function isAbortRequest(request: Request, agentName: string, instanceName: string): boolean {
	if (request.method !== 'POST') return false;
	const segments = new URL(request.url).pathname.split('/');
	const n = segments.length;
	if (n < 4) return false;
	return (
		segments[n - 1] === 'abort' &&
		decodeURIComponent(segments[n - 2] as string) === instanceName &&
		decodeURIComponent(segments[n - 3] as string) === agentName
	);
}
