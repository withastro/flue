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
	emitSubmissionAttemptChanged,
	emitSubmissionRecoveryDecision,
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

const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';
const FLUE_AGENT_SUBMISSION_WAKE_SECONDS = 30;
const FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER = 'flue:submission-attempt';
/**
 * How long past a deadline (durability timeout, or a durable abort intent) a
 * live attempt fiber gets to unwind through its own settle path after its
 * controller is aborted, before the supervisor force-settles the submission
 * over it. Signal-aware awaits (provider fetches, exec) unwind well inside
 * this; only a signal-deaf hang (a sandbox RPC pending against a
 * healthy-reporting container, a wedged stream reader) reaches the force
 * path. Two heartbeat periods, so the abort is guaranteed at least one full
 * pass to land before force-settlement.
 */
const FLUE_AGENT_SUBMISSION_SETTLE_GRACE_MS = 2 * FLUE_AGENT_SUBMISSION_WAKE_SECONDS * 1000;

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
		/**
		 * DurableObjectState.waitUntil. Optional because test fakes and older
		 * SDK surfaces may omit it; a detached attempt fiber survives without
		 * it (the durable keepAlive alarm chain re-enters through fiber
		 * recovery), waitUntil just tells the platform the work is deliberate.
		 */
		waitUntil?(promise: Promise<unknown>): void;
	};
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

/**
 * Handle for a started attempt. `running` is the guarded fiber promise
 * (never rejects; resolves after settlement AND cleanup). Wrapped in an
 * object so async plumbing can hand it around without the runtime flattening
 * a returned promise into an inline await of the whole attempt.
 */
interface StartedSubmissionAttempt {
	readonly submissionId: string;
	readonly running: Promise<void>;
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
	 * The single place submission attempts start. Dispatched by the
	 * `__flueWakeAgentSubmissions` schedule target from inside the Durable
	 * Object's alarm invocation as one bounded, storage-only supervisor
	 * pass: it reconciles durable state, enforces deadlines, and starts
	 * attempt fibers detached — the pass returns without awaiting agent
	 * execution, so a hung attempt can never block supervision, and the
	 * pass arms its successor heartbeat before doing any failable work.
	 * Attempt fibers ride the SDK's runFiber keepAlive/recovery machinery
	 * across invocations and isolates. Every other boundary only records
	 * durable intent and arms this drain.
	 */
	drainSubmissions(instance: CloudflareAgentInstance): Promise<void>;
	onRequest(instance: CloudflareAgentInstance, request: Request): Promise<Response | null>;
	onFiberRecovered(
		instance: CloudflareAgentInstance,
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown>;
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
		drainSubmissions(instance) {
			return getCoordinator(instance).drainSubmissions();
		},
		onRequest(instance, request) {
			return getCoordinator(instance).onRequest(request);
		},
		onFiberRecovered(instance, ctx, inherited) {
			return getCoordinator(instance).onFiberRecovered(ctx, inherited);
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
	 * Abort controllers for in-flight attempt fibers in this isolate, keyed by
	 * submissionId, so an incoming cancel request can abort the running attempt.
	 * The DO is single-threaded but interleaves at `await` points, so a cancel
	 * request can set the controller while the fiber is suspended on provider
	 * I/O. If the isolate is evicted the controller is gone and the abort
	 * falls back to the durable `abortRequestedAt` + reconcile path.
	 */
	private activeControllers = new Map<string, AbortController>();
	/**
	 * When each live attempt's controller was first fired by deadline
	 * enforcement, keyed by the controller so a replacement attempt starts
	 * its own clock. In-memory is exactly coextensive with the enforcement
	 * itself: both only apply to fibers live in this isolate.
	 */
	private attemptDeadlineSignaledAt = new WeakMap<AbortController, number>();

	// Instance context is established at exactly two boundaries: the public
	// coordinator entry points below (onStart/drainSubmissions/onRequest/
	// onFiberRecovered/onAlarm) and the durable submission fiber in
	// startSubmissionAttempt. These are the only ways execution enters the
	// Durable Object, and a recovered fiber resumes with no ambient context, so
	// each must (re)establish it. onAlarm wraps the Agents SDK alarm handler,
	// covering every scheduled callback it dispatches — including
	// extension-authored schedule/scheduleEvery/queue targets (#437); Flue's
	// own wake target still self-wraps via drainSubmissions, which simply
	// nests. Everything reachable from these boundaries — dispatch admission,
	// reconciliation, materialization, submission processing — assumes the
	// context is already present and never re-wraps.
	//
	// Execution ownership: attempts start ONLY inside drainSubmissions'
	// supervisor pass, which runs as an alarm-dispatched schedule callback.
	// The pass is bounded and storage-only — it never awaits agent execution.
	// Attempt fibers run detached: the SDK's runFiber keepAlive holds a ≤30s
	// durable alarm chain for a fiber's whole lifetime, and fiber recovery
	// re-enters through onFiberRecovered if the isolate dies with the fiber.
	// Supervision therefore never inherits an attempt's liveness: a hung
	// await inside a fiber cannot block deadline enforcement, and the
	// heartbeat is armed BEFORE the pass does any failable work, so no
	// single pass failure (throw, platform cancellation, code-update reset)
	// can break the wake chain — a lost wake costs one heartbeat of latency,
	// never settlement. All other boundaries (admission, abort, onStart,
	// onFiberRecovered) record durable intent and arm the drain. The SDK
	// deletes a one-shot schedule row only AFTER its callback returns, so an
	// armed row doubles as durable recovery on isolate death.
	onStart(inherited: () => Promise<unknown> | unknown): Promise<void> {
		return this.runWithInstanceContext(async () => {
			// A fresh isolate has no live attempt by definition, so unsettled
			// work needs nothing beyond a drain: its reconcile pass classifies
			// interrupted attempts directly. Arm before the (possibly
			// extension-authored) inherited onStart — the durable driver must be
			// in place even if extension startup throws.
			await this.armDrainIfUnsettled();
			await inherited();
		});
	}

	/**
	 * In-isolate serialization of supervisor passes. Alarm-dispatched wakes
	 * are serialized by the platform (one `alarm()` at a time), but a direct
	 * call while a pass is live must not interleave with it. A promise chain
	 * instead of a boolean guard: a wake that arrives mid-pass queues its own
	 * full pass rather than being silently consumed — no code path can eat a
	 * wake without doing (or scheduling) the work it promised. Passes are
	 * bounded and storage-only, so the chain drains in bounded time.
	 */
	private supervisorChain: Promise<void> = Promise.resolve();

	drainSubmissions(): Promise<void> {
		const pass = this.supervisorChain.then(() =>
			this.runWithInstanceContext(() => this.supervisorPass()),
		);
		// The chain absorbs rejections so one failed pass can't wedge every
		// later one; the caller's `pass` still rejects, preserving the SDK's
		// schedule-callback deferral semantics (code-update resets and
		// transient platform errors rethrow so the preserved row re-runs).
		this.supervisorChain = pass.then(
			() => undefined,
			() => undefined,
		);
		return pass;
	}

	/**
	 * One bounded supervisor pass: arm the heartbeat, reconcile durable
	 * state (settlement finalization, interrupted-attempt recovery, deadline
	 * enforcement), claim runnable work, and start attempt fibers WITHOUT
	 * awaiting them — fibers settle their submissions themselves and re-enter
	 * through onFiberSettled. The pass never waits on agent execution, so
	 * supervision stays live no matter what any attempt is doing.
	 */
	private async supervisorPass(): Promise<void> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return;
		// Heartbeat-first: the successor wake is armed before any failable
		// work, so a pass that throws, or an invocation the platform cancels,
		// leaves a live wake behind. The extra rows this arms are cheap no-op
		// passes. Non-idempotent — an idempotent arm from inside this callback
		// could dedupe onto the row being executed, which the SDK deletes
		// after return, losing the wake.
		await this.armBackstop();
		// The reconcile pass is storage-only and runs under the
		// `flue.coordinator` interception so tracing backends can group
		// its platform-instrumented storage spans. Attempt fibers start
		// AFTER the interception settles, deliberately: `runFiber` runs
		// its callback in the caller's async context, so a fiber started
		// inside the span's activation would re-parent its invoke_agent
		// span under the coordinator span. A claim whose start is
		// preempted here (crash, code-update reset) is an interrupted
		// attempt with no live controller — the next pass's
		// running-recovery loop reconciles it, and a durable abort in the
		// claim-to-start gap resolves through the existing
		// abortRequestedAt path.
		const claims = await interceptExecution(
			{ type: 'coordinator', phase: 'reconcile' },
			{ instanceId: this.instance.name, agentName: this.agentName },
			() => this.reconcileSubmissions(),
		);
		for (const claimed of claims) {
			try {
				const attempt = await this.startSubmissionAttempt(claimed);
				if (attempt) this.watchAttempt(attempt);
			} catch (error) {
				this.logSubmissionReconciliationFailure(claimed, 'start_submission', error);
			}
		}
		// observe() deliveries are fire-and-forget on the emit path; hand
		// whatever this pass emitted (deadline signals, force settlements) to
		// the platform so the invocation's end can't tear them down mid-POST.
		this.instance.ctx.waitUntil?.(drainGlobalEventDeliveries());
	}

	/**
	 * Detach an attempt fiber from the pass that started it. `running` is
	 * catch-guarded and finally-cleaned in startSubmissionAttempt, so the
	 * tail here cannot reject. When the fiber settles its submission, any
	 * queued work behind it becomes runnable — arm a zero-delay wake so the
	 * queue progresses promptly instead of waiting out the heartbeat. A
	 * fiber that ends with its submission still unsettled (a failure inside
	 * settlement itself) deliberately does NOT arm: the heartbeat owns that
	 * class at polling cadence, which throttles a pathological
	 * claim/crash/reclaim cycle instead of hot-looping it.
	 */
	private watchAttempt(attempt: StartedSubmissionAttempt): void {
		const tail = attempt.running.then(async () => {
			try {
				const settled =
					(await this.submissions.getSubmission(attempt.submissionId))?.status === 'settled';
				if (settled && (await this.submissions.hasUnsettledSubmissions())) {
					await this.armDrain();
				}
			} catch {
				// Wake arming is best-effort here: the heartbeat armed by the
				// starting pass (and every pass since) covers the work.
			}
			// The fiber's settlement events (submission_settled and any
			// subscriber bridge work they trigger) ride this waitUntil too.
			await drainGlobalEventDeliveries();
		});
		// Tell the platform the invocation intentionally leaves work running.
		// Without waitUntil the fiber still survives: runFiber's keepAlive
		// alarm chain re-wakes the DO and fiber recovery re-enters the drain.
		this.instance.ctx.waitUntil?.(tail);
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

	/**
	 * The SDK detected one of our attempt fibers interrupted (crash replay on
	 * a fresh isolate, or a survived run row after a reset). The durable
	 * submission row already carries everything recovery needs — the drain's
	 * reconcile pass classifies it — so the only job here is ensuring a drain
	 * runs. Resolving (not throwing) tells the SDK the recovery is handled,
	 * which deletes its run row.
	 */
	onFiberRecovered(
		ctx: CloudflareAgentRecoveredFiberContext,
		inherited: () => Promise<unknown> | unknown,
	): Promise<unknown> {
		return this.runWithInstanceContext(async () => {
			if (ctx.name !== FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER) return inherited();
			await this.armDrain();
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

	private assertAgentsDurabilityApi(method: 'runFiber' | 'schedule'): void {
		if (typeof this.instance[method] !== 'function') {
			throw new Error(
				`[flue] The installed "agents" package does not provide the required Cloudflare Agents SDK method "${method}". Upgrade @flue/vite (which supplies the Cloudflare Agents SDK), or remove the "agents" dependency from your project if it declares an older one.`,
			);
		}
	}

	/**
	 * Arm a zero-delay drain. Always non-idempotent: an idempotent arm can
	 * dedupe onto a drain row that is currently executing — the SDK keeps the
	 * row in `cf_agents_schedules` until its callback returns, then deletes
	 * it — so an admission landing in the tail of a running drain would lose
	 * its wake entirely. A fresh row per arm closes that race; extra rows
	 * fire cheap no-op drains.
	 */
	private armDrain(): Promise<unknown> {
		this.assertAgentsDurabilityApi('schedule');
		return this.instance.schedule(0, FLUE_AGENT_SUBMISSION_WAKE_CALLBACK, undefined, {
			idempotent: false,
		});
	}

	/** 30s backstop wake onto the same schedule target (see armDrain for why non-idempotent). */
	private armBackstop(): Promise<unknown> {
		this.assertAgentsDurabilityApi('schedule');
		return this.instance.schedule(
			FLUE_AGENT_SUBMISSION_WAKE_SECONDS,
			FLUE_AGENT_SUBMISSION_WAKE_CALLBACK,
			undefined,
			{ idempotent: false },
		);
	}

	private async armDrainIfUnsettled(): Promise<boolean> {
		if (!(await this.submissions.hasUnsettledSubmissions())) return false;
		await this.armDrain();
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
				// Attempt fibers run detached from supervisor passes, so a running
				// row here is live exactly when its attempt controller is still
				// registered in this isolate. No controller means the attempt is
				// dead (isolate replacement, fiber crash past its cleanup, or a
				// start preempted in the claim-to-start gap) and the row goes to
				// interrupted-attempt reconciliation. A live row is left alone
				// until a deadline demands enforcement — see
				// enforceLiveAttemptDeadline. A zombie fiber that outlives either
				// path is fenced by the claim CAS and attempt-id ownership checks
				// on every durable write.
				const liveController = this.activeControllers.get(submission.submissionId);
				if (liveController && !this.enforceLiveAttemptDeadline(submission)) {
					continue;
				}
				try {
					const replacement = await this.reconcileInterruptedSubmission(submission);
					// The attempt fiber starts after the reconcile pass returns —
					// see supervisorPass for why starts must escape the pass's
					// tracing activation.
					if (replacement) toStart.push(replacement);
					if (liveController) this.orphanEnforcedAttempt(submission.submissionId, liveController);
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
					attemptId: generateAttemptId(),
					ownerId: this.instance.ctx.id.toString(),
					leaseExpiresAt: 0,
				});
				if (claimed) {
					emitSubmissionAttemptChanged(
						submission,
						claimed,
						'claim_submission',
						this.emitCoordinatorEvent,
					);
					toStart.push(claimed);
				}
			}
		} catch (error) {
			emitSubmissionRecoveryDecision(this.emitCoordinatorEvent, {
				operation: 'reconcile_pass',
				reason: 'reconcile_failed',
				error,
			});
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
		if (operation === 'reconcile_submission') {
			emitSubmissionRecoveryDecision(this.emitCoordinatorEvent, {
				submission,
				operation,
				reason: 'reconcile_failed',
				error,
			});
		}
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
	 * Deadline enforcement for an attempt fiber that is still live in this
	 * isolate. When a deadline has passed — the durability timeout, or a
	 * durable abort intent the fiber has not honored — fire the attempt's
	 * abort controller so a signal-aware await unwinds through the fiber's
	 * own settle path (`processSubmission` settles failed/aborted durably
	 * and emits the live event). Returns true — demand interrupted-attempt
	 * reconciliation NOW, settling over the live fiber — only once the
	 * deadline is more than FLUE_AGENT_SUBMISSION_SETTLE_GRACE_MS old and
	 * the fiber still has not settled: a signal-deaf hang (a sandbox RPC
	 * pending against a healthy-reporting container, a wedged stream
	 * reader). The hung fiber is orphaned; its late writes lose the
	 * settlement CAS and attempt-id fences.
	 */
	private enforceLiveAttemptDeadline(submission: AgentSubmission): boolean {
		const now = Date.now();
		const timedOut = submission.timeoutAt > 0 && now >= submission.timeoutAt;
		const abortRequested = submission.abortRequestedAt !== undefined;
		if (!timedOut && !abortRequested) return false;
		const controller = this.activeControllers.get(submission.submissionId);
		if (!controller) return true;
		// Abort intent wins over timeout, mirroring the settle-order in
		// reconcileInterruptedSubmission. AbortController.abort is idempotent,
		// so re-signaling on every pass is safe.
		controller.abort(
			abortRequested ? new SubmissionAbortedError() : new SubmissionTimeoutError(),
		);
		// The grace is anchored to when the fiber was first SIGNALED, not to
		// the deadline itself: a delayed first pass (late alarms) must not
		// abort and force-settle in the same breath. Abort intents were
		// signaled at request time (abortInstance fires the controller in
		// this isolate), so they seed from abortRequestedAt.
		const signaledAt = this.attemptDeadlineSignaledAt.get(controller);
		const deadline =
			signaledAt ??
			(abortRequested && submission.abortRequestedAt !== undefined
				? Math.min(submission.abortRequestedAt, now)
				: now);
		if (signaledAt === undefined) this.attemptDeadlineSignaledAt.set(controller, deadline);
		if (now < deadline + FLUE_AGENT_SUBMISSION_SETTLE_GRACE_MS) {
			this.emitCoordinatorEvent({
				type: 'submission_recovery',
				submissionId: submission.submissionId,
				kind: submission.kind,
				operation: 'enforce_deadline',
				outcome: 'deferred',
				attemptCount: submission.attemptCount,
				maxAttempts: submission.maxAttempts,
				error: serializeSubmissionError(
					abortRequested
						? new SubmissionAbortedError()
						: new SubmissionTimeoutError(),
				),
			});
			return false;
		}
		console.error('[flue:submission-reconciliation]', {
			agentName: this.agentName,
			instanceId: this.instance.name,
			submissionId: submission.submissionId,
			sessionKey: submission.sessionKey,
			attemptId: submission.attemptId,
			operation: 'enforce_deadline',
			outcome: 'terminated',
			reason: abortRequested ? 'abort_unhonored' : 'exceeded_timeout',
		});
		return true;
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
	 * Start one attempt fiber and return a handle carrying its guarded
	 * promise for the drain to await. The promise never rejects (failures
	 * settle durably in processSubmission and are logged here) and resolves
	 * only after the abort-controller cleanup, so the drain's next reconcile
	 * pass observes consistent state.
	 * The handle object exists because returning the promise directly from
	 * this async method would flatten it: callers would await the whole
	 * attempt instead of receiving something awaitable.
	 */
	private async startSubmissionAttempt(
		submission: AgentSubmission,
	): Promise<StartedSubmissionAttempt | undefined> {
		if (submission.status !== 'running' || !submission.attemptId) return undefined;
		this.assertAgentsDurabilityApi('runFiber');
		const controller = new AbortController();
		this.activeControllers.set(submission.submissionId, controller);
		let running: Promise<void>;
		try {
			running = this.instance.runFiber(FLUE_AGENT_SUBMISSION_ATTEMPT_FIBER, async (fiberCtx) => {
				fiberCtx.stash({ submissionId: submission.submissionId, attemptId: submission.attemptId });
				// The fiber is the second context boundary: it may resume on a
				// fresh isolate (via the SDK's crash replay) with no ambient
				// context, so it establishes its own.
				await this.runWithInstanceContext(() =>
					this.processSubmissionEntry(submission, controller.signal),
				);
			});
		} catch (error) {
			this.deleteControllerIfCurrent(submission.submissionId, controller);
			throw error;
		}
		return {
			running: running
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
					// Usually post-settlement (processSubmission settles failed
					// durably and emits the live submission_settled before
					// rethrowing); when the failure struck settlement itself the
					// row is still unsettled and the backstop owns it.
					this.emitCoordinatorEvent(
						{
							type: 'submission_recovery',
							submissionId: submission.submissionId,
							kind: submission.kind,
							operation: 'process_submission',
							outcome: 'deferred',
							error: serializeSubmissionError(error),
						},
						{ errorInfo: classifyError(error) },
					);
				})
				.finally(() => {
					this.deleteControllerIfCurrent(submission.submissionId, controller);
				}),
			submissionId: submission.submissionId,
		};
	}

	/**
	 * Controllers are keyed by submissionId and shared across attempts, so a
	 * late cleanup from a superseded attempt (its fiber promise settling after
	 * a replacement attempt already registered its own controller) must not
	 * delete the replacement's controller — that would sever the abort path
	 * for a live attempt.
	 */
	private deleteControllerIfCurrent(submissionId: string, controller: AbortController): void {
		if (this.activeControllers.get(submissionId) === controller) {
			this.activeControllers.delete(submissionId);
		}
	}

	/**
	 * After deadline enforcement settled over a live-but-hung fiber, orphan
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
		// Abort any of those attempt fibers live in this isolate —
		// processSubmission's catch settles them aborted and the fiber tail
		// arms the next wake. Queued ones settle via the pre-execution abort
		// check once a pass claims them; an evicted running attempt is driven
		// by the durable flag through reconciliation, and a signal-deaf live
		// fiber is force-settled by enforceLiveAttemptDeadline once the abort
		// intent outlives the settle grace.
		for (const submissionId of affected) {
			this.activeControllers.get(submissionId)?.abort(new SubmissionAbortedError());
		}
		await this.armDrain();
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
			await this.armDrain();
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
			await this.armDrain();
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
						await this.armDrain();
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
				await this.armDrain();
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
