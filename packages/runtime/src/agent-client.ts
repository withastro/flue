/**
 * `init()` — the programmatic client for one agent instance.
 *
 * The handle is an *address*, not a resource: `init()` creates nothing, and
 * the instance itself is created on first contact exactly as it would be for
 * any other delivery. Three verbs:
 *
 * - `dispatch()` delivers one message through the dispatch queue and resolves
 *   at admission with the durable {@link DispatchReceipt} — the same contract
 *   as the top-level `dispatch()`, its payload minus the `id`/`uid` the
 *   handle owns, with a string shorthand for a plain user message. Every hook
 *   (`useDelivery`, `useAgentStart`, `useAgentFinish`, state, output, joins)
 *   fires exactly as it does on the other transports.
 * - `read()` awaits one submission's settlement and resolves with its reply.
 *   Settlement is a durable conversation record, so a read re-attaches: any
 *   process can read a submission it did not dispatch, at any later time,
 *   and a submission that settled long ago resolves immediately. A receipt
 *   persisted across a crash (say, as a workflow step's durable result) is
 *   all a retry needs.
 * - `abort()` requests a durable abort of the instance's in-flight and
 *   queued work; a concurrent `read()` observes the aborted settlement.
 *
 * Like the top-level verb, the handle taps the process's one configured Flue
 * runtime: it works inside a Flue server (a cron callback in app.ts), in a
 * standalone script after `start()` from `@flue/runtime/node`, under
 * `flue run`, and inside a deployed Cloudflare Worker — including Workflow
 * steps. No in-memory state is load-bearing: if the process dies between
 * `dispatch()` and `read()`, the submission survives exactly as the
 * configured store persists it, and a later `read()` picks up where the
 * lost await stopped.
 */

import type { AgentConversationSnapshot, ConversationStreamChunk } from './conversation-public.ts';
import { AgentInstanceNotFoundError, InvalidRequestError } from './errors.ts';
import {
	observeSubmissionSettlement,
	readSubmissionReply,
	replyFromSnapshot,
	type SubmissionReply,
	type SubmissionSettlement,
	settlementFromChunk,
	throwIfAborted,
} from './runtime/conversation-observer.ts';
import { enqueueDispatch } from './runtime/dispatch.ts';
import type { CloudflareRuntime, FlueRuntime, NodeRuntime } from './runtime/flue-app.ts';
import { getAgentInstance, getFlueRuntime } from './runtime/flue-app.ts';
import { generateInstanceId } from './runtime/ids.ts';
import { normalizeMessageInput } from './runtime/message-input.ts';
import { getRegisteredAgentIdentity } from './runtime/registration.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import type { Agent, AgentDispatchRequest, DispatchReceipt } from './types.ts';

export interface InitOptions {
	/**
	 * The instance address. Omit to mint a fresh unique one — a throwaway
	 * instance for this run. Pass a stable id (e.g. `nightly-2026-07-08`) to
	 * address an instance that later sends can find again.
	 */
	id?: string;
	/**
	 * Send condition for the handle's first contact (uid ≈ ETag): a string
	 * continues only that incarnation, `null` creates only when no instance
	 * exists, omit to send unconditionally. After a send's receipt, the handle
	 * pins the incarnation it contacted and later sends continue it.
	 */
	uid?: string | null;
}

/**
 * The handle-scoped dispatch payload: exactly the top-level `dispatch()`
 * request, minus the address (`id`) and send condition (`uid`) the handle
 * itself owns — `{ message, initialData? }`. `initialData` seeds the instance
 * only on the send that creates it; once the handle has contacted the
 * instance it is ignored, exactly as a top-level `dispatch()` to an existing
 * instance ignores it.
 */
export type AgentHandleDispatchRequest = Omit<AgentDispatchRequest, 'id' | 'uid'>;

export interface AgentReadOptions {
	/** Receives every projected conversation chunk as it is durably recorded. */
	onEvent?: (chunk: ConversationStreamChunk) => void;
	/**
	 * Stops the read: the call rejects with the signal's reason. Cancelling a
	 * read is purely local — the submission keeps running and stays readable.
	 * To durably stop the agent's work instead, call `abort()` on the handle;
	 * a live `read()` then observes the aborted settlement.
	 */
	signal?: AbortSignal;
}

/** The settled reply a `read()` resolves with. */
export interface AgentReply {
	/** Final assistant text produced by the submission ('' when none). */
	text: string;
	/** Named client data parts (`useDataWriter`) on the reply, keyed by name. */
	data: Record<string, unknown[]>;
	/** Agent-authored response metadata (`useResponseStart`/`useResponseFinish`), when present. */
	metadata?: Record<string, unknown>;
	/** The contacted incarnation's uid (minted when this send created). */
	uid?: string;
	submissionId: string;
}

/** A `read()` whose submission settled `failed` or `aborted`. */
export class AgentRunError extends Error {
	readonly outcome: 'failed' | 'aborted';
	readonly submissionId: string;

	constructor(options: { outcome: 'failed' | 'aborted'; submissionId: string; cause?: unknown }) {
		super(
			`[flue] Agent run ${options.outcome === 'aborted' ? 'was aborted' : 'failed'} ` +
				`(submission ${options.submissionId}).`,
			options.cause === undefined ? undefined : { cause: options.cause },
		);
		this.name = 'AgentRunError';
		this.outcome = options.outcome;
		this.submissionId = options.submissionId;
	}
}

/** A programmatic handle addressing one agent instance. */
export interface AgentInstanceHandle {
	/** The instance address this handle targets. */
	readonly id: string;
	/**
	 * Deliver one message; resolves at admission with the durable
	 * {@link DispatchReceipt}. Takes the top-level `dispatch()` request
	 * payload minus the `id`/`uid` the handle owns —
	 * `{ message, initialData? }` — or a bare string as shorthand for
	 * `{ message }`. To then await the reply, pass the receipt to `read()`.
	 */
	dispatch(request: string | AgentHandleDispatchRequest): Promise<DispatchReceipt>;
	/**
	 * Await one submission's settlement and resolve with its reply. Takes a
	 * dispatch receipt, or the bare submission id (a receipt's
	 * `submissionId`). Rejects with {@link AgentRunError} on a failed or
	 * aborted settlement.
	 *
	 * Re-attachable: settlement and reply are durable conversation records,
	 * so a read works from any process at any later time — a submission that
	 * settled long ago resolves immediately, and reading the same submission
	 * again returns the same reply. Concurrent deliveries to one instance
	 * serialize (or join a live response at a turn boundary); a delivery that
	 * joined reads the coalesced reply that answered it. A read addressed to
	 * an instance that does not exist rejects with
	 * {@link AgentInstanceNotFoundError}; on an existing instance, an
	 * unsignalled read waits indefinitely for settlement — a submission id
	 * that never existed there is a programming error the read cannot detect.
	 */
	read(target: string | DispatchReceipt, options?: AgentReadOptions): Promise<AgentReply>;
	/**
	 * Request a durable abort of the instance's work — the running head and
	 * every queued submission behind it. Resolves once the intent is
	 * recorded; the distinct `aborted` settlement lands asynchronously, where
	 * a live `read()` observes it.
	 */
	abort(): Promise<void>;
}

/**
 * Address an agent instance for programmatic control.
 *
 * ```ts
 * const agent = init(reporter, { id: `nightly-${date}` });
 * const receipt = await agent.dispatch({
 *   message: 'You have been triggered. Produce the nightly report.',
 *   initialData: { date },
 * });
 * const reply = await agent.read(receipt);
 * console.log(reply.text);
 * ```
 *
 * The `agent` argument is the agent function itself, registered with this
 * app (the same contract as `dispatch()`). The runtime is resolved when the
 * handle is used, not when it is created, so `init()` at module scope is
 * safe.
 */
export function init(agent: Agent, options: InitOptions = {}): AgentInstanceHandle {
	if (!isAgentFunction(agent)) {
		throw new InvalidRequestError({
			reason: 'init() requires an agent function as its first argument: init(agent, { id }).',
		});
	}
	if (options.id !== undefined && (typeof options.id !== 'string' || options.id.trim() === '')) {
		throw new Error('[flue] init() requires a non-empty string instance id when one is given.');
	}
	const id = options.id ?? generateInstanceId();

	// The handle's first send carries the send condition; afterwards the
	// handle continues the incarnation it contacted.
	let contacted = false;
	let pinnedUid: string | undefined;
	const uidCondition = () => {
		if (contacted) return pinnedUid !== undefined ? { uid: pinnedUid } : {};
		return options.uid !== undefined ? { uid: options.uid } : {};
	};

	return {
		id,

		async dispatch(request) {
			const payload = normalizeHandleDispatchRequest(request);
			const rt = requireRuntime('init');
			const name = resolveAgentName(agent, 'init');
			const delivered = normalizeMessageInput(payload.message);

			// initialData seeds the instance only on the send that creates it.
			// After first contact the handle pins the incarnation's uid onto
			// every send, and a uid-conditioned send cannot carry initialData —
			// so drop it on later sends (the instance already exists) rather
			// than raise the wire contradiction, matching top-level dispatch's
			// ignore-on-existing semantics.
			const receipt = await enqueueDispatch({
				request: {
					agent: name,
					id,
					message: delivered,
					...(payload.initialData !== undefined && !contacted
						? { initialData: payload.initialData }
						: {}),
					...uidCondition(),
				},
				dispatchQueue: rt.dispatchQueue,
			});
			contacted = true;
			if (receipt.uid !== undefined) pinnedUid = receipt.uid;
			return receipt;
		},

		async read(target, readOptions = {}) {
			const { submissionId, uid } = normalizeReadTarget(target);
			const rt = requireRuntime('init');
			const name = resolveAgentName(agent, 'init');

			// Fail fast on an instance that does not exist (a typo'd id, a
			// receipt for a different agent): a read waits for settlement, and
			// waiting on an instance that was never contacted would wait
			// forever. Ids come from receipts, so this is a programming error
			// worth a loud, typed, immediate rejection on every target.
			if ((await getAgentInstance(agent, id)) === null) {
				throw new AgentInstanceNotFoundError({ id });
			}

			// Observed from the stream origin: a dispatch receipt carries no
			// offset, and settlement is a durable record — reading from the
			// start finds a past settlement instead of waiting forever.
			return awaitSettledReply(
				createSettlementTransport(rt, name, id),
				{ submissionId, offset: '-1', ...(uid !== undefined ? { uid } : {}) },
				readOptions,
			);
		},

		async abort() {
			const rt = requireRuntime('init');
			const name = resolveAgentName(agent, 'init');
			await createSettlementTransport(rt, name, id).requestAbort();
		},
	};
}

/**
 * A read target is the dispatch receipt itself, or the bare submission id.
 * The receipt form also carries the contacted incarnation's uid onto the
 * reply.
 */
function normalizeReadTarget(target: string | DispatchReceipt): {
	submissionId: string;
	uid?: string;
} {
	if (typeof target === 'string') {
		if (target.trim() === '') {
			throw new Error('[flue] The handle read() requires a non-empty submission id.');
		}
		return { submissionId: target };
	}
	if (
		typeof target !== 'object' ||
		target === null ||
		typeof target.submissionId !== 'string' ||
		target.submissionId === ''
	) {
		throw new Error('[flue] The handle read() takes a dispatch receipt or a submission id string.');
	}
	return { submissionId: target.submissionId, uid: target.uid };
}

/**
 * How one target aborts an instance's in-flight work, observes a submission's
 * settlement, and reads its reply. The awaited choreography above these three
 * operations is target-neutral ({@link awaitSettledReply}).
 */
interface SettlementTransport {
	/** Durable abort intent; the aborted settlement arrives on the stream. */
	requestAbort(): Promise<unknown>;
	observe(target: {
		submissionId: string;
		offset: string;
		onEvent?: (chunk: ConversationStreamChunk) => void;
		/** Stops the observation locally; never touches the submission. */
		signal?: AbortSignal;
	}): Promise<SubmissionSettlement>;
	readReply(submissionId: string): Promise<SubmissionReply>;
}

/**
 * The tail of a `read()`: watch the stream for the submission's durable
 * settlement, then read and return the reply. The caller's signal cancels
 * the observation only — a durable stop is the handle's `abort()`.
 */
async function awaitSettledReply(
	transport: SettlementTransport,
	target: { submissionId: string; offset: string; uid?: string },
	options: AgentReadOptions,
): Promise<AgentReply> {
	const settlement = await transport.observe({
		submissionId: target.submissionId,
		offset: target.offset,
		...(options.onEvent !== undefined ? { onEvent: options.onEvent } : {}),
		...(options.signal !== undefined ? { signal: options.signal } : {}),
	});
	if (settlement.outcome !== 'completed') {
		throw new AgentRunError({
			outcome: settlement.outcome,
			submissionId: target.submissionId,
			...(settlement.error === undefined ? {} : { cause: settlement.error }),
		});
	}
	const reply = await transport.readReply(target.submissionId);
	return {
		...reply,
		...(target.uid !== undefined ? { uid: target.uid } : {}),
		submissionId: target.submissionId,
	};
}

function createSettlementTransport(
	rt: FlueRuntime,
	agentName: string,
	instanceId: string,
): SettlementTransport {
	return rt.target === 'node'
		? nodeSettlementTransport(rt, agentName, instanceId)
		: cloudflareSettlementTransport(rt, agentName, instanceId);
}

function nodeSettlementTransport(
	node: NodeRuntime,
	agentName: string,
	instanceId: string,
): SettlementTransport {
	const path = agentStreamPath(agentName, instanceId);
	return {
		requestAbort: () => node.abortAgentInstance(agentName, instanceId),
		observe: (target) =>
			observeSubmissionSettlement({
				store: node.conversationStreamStore,
				path,
				submissionId: target.submissionId,
				offset: target.offset,
				...(target.onEvent !== undefined ? { onEvent: target.onEvent } : {}),
				...(target.signal !== undefined ? { signal: target.signal } : {}),
			}),
		readReply: (submissionId) =>
			readSubmissionReply({ store: node.conversationStreamStore, path, submissionId }),
	};
}

/**
 * Cloudflare: the conversation stream store lives inside the agent's Durable
 * Object, so observation runs over the DO's existing conversation read route —
 * a loop of bounded long-poll requests (each within the route's 30s window),
 * the same protocol the web client reads. Settlement chunks appear on that
 * stream for every submission kind, so no dedicated wait contract is needed.
 * Requests route with no per-request env; the entry's runtime seed falls back
 * to the worker's module-scope env, which is what lets the handle work in
 * cron callbacks, queue consumers, and Workflow steps.
 */
function cloudflareSettlementTransport(
	cf: CloudflareRuntime,
	agentName: string,
	instanceId: string,
): SettlementTransport {
	const base = `https://flue.invalid/agents/${encodeURIComponent(agentName)}/${encodeURIComponent(instanceId)}`;
	const route = async (request: Request): Promise<Response> => {
		const response = await cf.routeAgentRequest(request, undefined, { agentName, instanceId });
		if (!response) {
			throw new Error(
				`[flue] init() target agent "${agentName}" Durable Object binding is unavailable.`,
			);
		}
		return response;
	};
	// The conversation stream is created on the instance's first contact, so
	// its 404 means the instance does not exist — surface the same typed
	// error the pre-observation existence check throws (this covers the race
	// where the check passed against a different process's stale view).
	const throwIfInstanceMissing = async (response: Response): Promise<void> => {
		if (response.status !== 404) return;
		const body = (await response.json().catch(() => undefined)) as
			{ error?: { type?: string } } | undefined;
		if (body?.error?.type === 'stream_not_found') {
			throw new AgentInstanceNotFoundError({ id: instanceId });
		}
	};
	return {
		async requestAbort() {
			const response = await route(new Request(`${base}/abort`, { method: 'POST' }));
			if (!response.ok) throw routeFailure('abort request', agentName, response);
			return response;
		},
		async observe(target) {
			let offset = target.offset;
			while (true) {
				throwIfAborted(target.signal);
				// Each poll is bounded by the route's long-poll window, so a
				// cancelled observation abandons at most one bounded request.
				const response = await cancellable(
					route(
						new Request(`${base}?view=updates&offset=${encodeURIComponent(offset)}&live=long-poll`),
					),
					target.signal,
				);
				if (!response.ok) {
					await throwIfInstanceMissing(response);
					throw routeFailure('conversation observation', agentName, response);
				}
				const chunks = (await response.json()) as ConversationStreamChunk[];
				let settlement: SubmissionSettlement | undefined;
				for (const chunk of chunks) {
					target.onEvent?.(chunk);
					settlement ??= settlementFromChunk(chunk, target.submissionId);
				}
				if (settlement) return settlement;
				offset = response.headers.get('Stream-Next-Offset') ?? offset;
			}
		},
		async readReply(submissionId) {
			const response = await route(new Request(`${base}?view=history`));
			if (!response.ok) {
				await throwIfInstanceMissing(response);
				throw routeFailure('reply read', agentName, response);
			}
			const snapshot = (await response.json()) as AgentConversationSnapshot;
			return replyFromSnapshot(snapshot, submissionId);
		},
	};
}

function routeFailure(action: string, agentName: string, response: Response): Error {
	return new Error(
		`[flue] init() ${action} for agent "${agentName}" failed with status ${response.status}.`,
	);
}

function requireRuntime(api: string): FlueRuntime {
	const rt = getFlueRuntime();
	if (!rt) {
		throw new Error(
			`[flue] ${api}() was used before the Flue runtime was configured. ` +
				'Inside a Flue-built server this happens automatically; in a standalone ' +
				"script, call start() from '@flue/runtime/node' first.",
		);
	}
	return rt;
}

function resolveAgentName(agent: Agent, api: string): string {
	const name = getRegisteredAgentIdentity(agent);
	if (!name) {
		throw new Error(`[flue] ${api}() target agent is not registered in this built application.`);
	}
	return name;
}

function isAgentFunction(value: unknown): value is Agent {
	// Twin: `assertAgentFunction` in registration.ts — keep in sync.
	return typeof value === 'function';
}

/**
 * Race a bounded request against the caller's read-cancellation signal. The
 * abandoned request completes within its own long-poll window and nothing
 * durable depends on its result.
 */
function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	throwIfAborted(signal);
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => {
			// Swallow the abandoned request's eventual outcome so a late
			// rejection cannot surface as an unhandled rejection.
			promise.catch(() => {});
			reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		promise.then(
			(value) => {
				signal.removeEventListener('abort', onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener('abort', onAbort);
				reject(error);
			},
		);
	});
}

/**
 * The handle accepts the top-level dispatch payload 1:1 (string shorthand
 * aside). A bare `DeliveredMessage`, or a payload smuggling the `id`/`uid`
 * the handle owns, fails loudly instead of misdelivering.
 */
function normalizeHandleDispatchRequest(
	request: string | AgentHandleDispatchRequest,
): AgentHandleDispatchRequest {
	if (typeof request === 'string') return { message: request };
	if (typeof request !== 'object' || request === null || !('message' in request)) {
		throw new Error(
			'[flue] The handle dispatch() takes a string or the dispatch payload object. ' +
				'Wrap a message value as dispatch({ message, initialData? }).',
		);
	}
	if ('id' in request || 'uid' in request) {
		throw new Error(
			'[flue] The handle dispatch() payload cannot carry "id" or "uid" — the handle owns ' +
				'the address and send condition. Pass them to init(agent, { id, uid }) instead.',
		);
	}
	return request;
}
