import type { ConversationRecord } from '../conversation-records.ts';
import { configureErrorRendering, InvalidRequestError } from '../errors.ts';
import type {
	Agent,
	AgentDispatchRequest,
	DispatchReceipt,
	NamedAgentDispatchRequest,
} from '../types.ts';
import type { AttachedAgentSubmissionAdmission } from './agent-submissions.ts';
import type { AttachmentStore } from './attachment-store.ts';
import type { ConversationStreamStore } from './conversation-stream-store.ts';
import { enqueueDispatch } from './dispatch.ts';
import type { DispatchQueue } from './dispatch-queue.ts';
import { normalizeMessageInput } from './message-input.ts';
import { getRegisteredAgentIdentity } from './registration.ts';
import type { RuntimeActivityGate } from './runtime-activity-gate.ts';
import { agentStreamPath } from './stream-offsets.ts';

interface RuntimeBase {
	devMode?: boolean;
	dispatchQueue: DispatchQueue;
	activityGate?: RuntimeActivityGate;
}

export interface NodeRuntime extends RuntimeBase {
	target: 'node';
	createAgentAdmission: (agentName: string, instanceId: string) => AttachedAgentSubmissionAdmission;
	/**
	 * Abort all in-flight and queued durable work for an agent instance.
	 * Resolves `true` when there was unsettled work to abort. Terminal
	 * settlement (the distinct aborted outcome) happens asynchronously.
	 */
	abortAgentInstance: (agentName: string, instanceId: string) => Promise<boolean>;
	conversationStreamStore: ConversationStreamStore;
	attachmentStore: AttachmentStore;
}

export interface CloudflareRuntime extends RuntimeBase {
	target: 'cloudflare';
	routeAgentRequest: (
		request: Request,
		env: unknown,
		target: { agentName: string; instanceId: string },
	) => Promise<Response | null>;
	/** Instance lookup for `getAgentInstance()`, served by the agent's Durable Object. */
	instanceInfo: (agentName: string, instanceId: string) => Promise<AgentInstanceInfo | null>;
}

export type FlueRuntime = NodeRuntime | CloudflareRuntime;

/**
 * Accepts input for asynchronous delivery to a continuing agent session —
 * THE delivery verb, for both message kinds: a `kind: 'signal'` event or a
 * `kind: 'user'` message (a bare string is shorthand for
 * `{ kind: 'user', body }`).
 *
 * Resolves after the current runtime admits and queues the input. It does not
 * wait for model processing, tool calls, or an agent reply. The returned
 * `submissionId` identifies delivery. To await the settled reply, use the
 * `init()` handle instead.
 *
 * The `agent` argument is the agent function itself, registered with this
 * app (an export of a `'use agent'` module, or a `start()` entry).
 *
 * Delivery durability depends on the generated target. Node uses a
 * process-lifetime in-memory queue by default. Cloudflare durably admits work
 * to the target agent Durable Object and may retry processing after an
 * interruption. Cloudflare processing can therefore be at-least-once; design
 * external side effects to be idempotent.
 */
export async function dispatch(
	agent: Agent,
	request: AgentDispatchRequest,
): Promise<DispatchReceipt> {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] dispatch() called before runtime was configured. ' +
				'This usually means it was used outside a Flue-built server entry.',
		);
	}
	if (!isAgentFunction(agent)) {
		throw new InvalidRequestError({
			reason:
				'dispatch() requires an agent function as its first argument: ' +
				'dispatch(agent, { id, message }).',
		});
	}
	return enqueueDispatch({
		request: resolveAgentDefinitionDispatchRequest(agent, request),
		dispatchQueue: rt.dispatchQueue,
	});
}

/** What `getAgentInstance()` reports about one existing agent instance. */
export interface AgentInstanceInfo {
	/** The instance id (the address the caller asked about). */
	id: string;
	/**
	 * The incarnation's uid — usable as the `uid` send condition. Absent while
	 * the instance's birth record has not yet landed (mid-materialization).
	 */
	uid?: string;
}

/**
 * Look up an agent instance by id: `null` when no instance exists, else its
 * {@link AgentInstanceInfo} including the uid usable as a send condition.
 *
 * Most callers never need this — unconditional sends work without a uid, a
 * creating send returns the fresh uid on its receipt, and a failed
 * `uid: null` condition hands the existing uid back in its error details.
 * Reach for it when code that did not create the instance wants to condition
 * a send without attempting one first.
 */
export async function getAgentInstance(
	agent: Agent,
	id: string,
): Promise<AgentInstanceInfo | null> {
	const rt = runtimeConfig;
	if (!rt) {
		throw new Error(
			'[flue] getAgentInstance() called before runtime was configured. ' +
				'This usually means it was used outside a Flue-built server entry.',
		);
	}
	if (!isAgentFunction(agent)) {
		throw new InvalidRequestError({
			reason:
				'getAgentInstance() requires an agent function as its first argument: ' +
				'getAgentInstance(agent, id).',
		});
	}
	if (typeof id !== 'string' || id.trim() === '') {
		throw new Error('[flue] getAgentInstance() requires a non-empty instance id.');
	}
	const name = getRegisteredAgentIdentity(agent);
	if (!name) {
		throw new Error(
			'[flue] getAgentInstance() target agent is not registered in this built application.',
		);
	}
	if (rt.target === 'cloudflare') return rt.instanceInfo(name, id);
	return readInstanceInfoFromStream(rt.conversationStreamStore, name, id);
}

/**
 * Node lookup: the root `conversation_created` record is the first record of
 * the instance's stream, so existence and uid come from stream meta plus the
 * first batch.
 */
export async function readInstanceInfoFromStream(
	store: ConversationStreamStore,
	agentName: string,
	instanceId: string,
): Promise<AgentInstanceInfo | null> {
	const path = agentStreamPath(agentName, instanceId);
	if ((await store.getMeta(path)) === null) return null;
	const read = await store.read(path, { offset: '-1', limit: 1 });
	for (const batch of read.batches) {
		for (const record of batch.records as ConversationRecord[]) {
			if (record.type === 'conversation_created' && record.kind === 'root') {
				return { id: instanceId, ...(record.uid !== undefined ? { uid: record.uid } : {}) };
			}
		}
	}
	// Stream exists but the birth record has not landed (mid-materialization).
	return { id: instanceId };
}

function isAgentFunction(value: unknown): value is Agent {
	// Twin: `assertAgentFunction` in registration.ts — keep in sync.
	return typeof value === 'function';
}

function resolveAgentDefinitionDispatchRequest(
	agent: Agent,
	request: AgentDispatchRequest | undefined,
): NamedAgentDispatchRequest {
	if (!request) throw new Error('[flue] dispatch(agent, request) requires a dispatch request.');
	const name = getRegisteredAgentIdentity(agent);
	if (!name) {
		throw new Error('[flue] dispatch() target agent is not registered in this built application.');
	}
	return {
		agent: name,
		id: request.id,
		message: normalizeMessageInput(request.message),
		...(request.initialData !== undefined ? { initialData: request.initialData } : {}),
		// `uid: null` is a meaningful condition (create-only), so presence is
		// keyed on the property, not on undefined.
		...('uid' in request && request.uid !== undefined ? { uid: request.uid } : {}),
	};
}

let runtimeConfig: FlueRuntime | undefined;

/**
 * Not part of the public API — exposed via `@flue/runtime/internal` only
 * because the generated entry imports it from a stable bare specifier.
 */
export function configureFlueRuntime(cfg: FlueRuntime): void {
	runtimeConfig = cfg;
	configureErrorRendering({ devMode: cfg.devMode ?? false });
}

export function resetFlueRuntimeForTests(): void {
	runtimeConfig = undefined;
	configureErrorRendering({ devMode: false });
}

export function getFlueRuntime(): FlueRuntime | undefined {
	return runtimeConfig;
}
