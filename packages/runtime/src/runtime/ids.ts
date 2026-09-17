import { ulid } from 'ulidx';

function generateSessionAffinityKey(): string {
	return `aff_${ulid()}`;
}

function generateConversationId(): string {
	return `conv_${ulid()}`;
}

export function generateOperationId(): string {
	return `op_${ulid()}`;
}

export function generateTurnId(): string {
	return `turn_${ulid()}`;
}

/**
 * The instance uid minted once at birth — names the incarnation (the
 * instance id is the reusable address; the uid distinguishes historical
 * occupants of the same id). Returned on send receipts and usable as a
 * send condition.
 */
export function generateInstanceUid(): string {
	return `inst_${ulid()}`;
}

/**
 * A fresh instance *address*, minted when `init()` is called without an id.
 * Distinct from {@link generateInstanceUid}: this names the reusable address
 * (normally caller-chosen, e.g. `daily-2026-07-08`), not the incarnation.
 */
export function generateInstanceId(): string {
	return `instance_${ulid()}`;
}

export function generateRecordId(): string {
	return `record_${ulid()}`;
}

/** A fresh conversation identity for a `conversation_created` record. */
export function createConversationIdentity(): {
	conversationId: string;
	affinityKey: string;
	createdAt: string;
} {
	return {
		conversationId: generateConversationId(),
		affinityKey: generateSessionAffinityKey(),
		createdAt: new Date().toISOString(),
	};
}

export function generateEntryId(): string {
	return `entry_${ulid()}`;
}

export function generateBlockId(): string {
	return `block_${ulid()}`;
}

export function generateTaskId(): string {
	return `task_${ulid()}`;
}

export function generateInvocationId(): string {
	return `inv_${ulid()}`;
}

/**
 * Every submission — dispatched or direct (attached HTTP / flue run) — gets
 * one of these. Historical dispatch submissions minted `dispatch_`-prefixed
 * ids; the values are opaque, so both prefixes remain valid identifiers.
 */
export function generateSubmissionId(): string {
	return `sub_${ulid()}`;
}

/**
 * Deterministic submission id for a caller-keyed admission: when a send
 * carries an `idempotencyKey`, the key becomes the submission id and a retry
 * lands on the existing idempotent admission machinery instead of minting a
 * fresh identity.
 *
 * FROZEN WIRE FORMAT — do not change the prefix or the preimage. A redelivery
 * after a deploy must derive the same id, so both are versioned by the
 * `flue-submission-key` label in the preimage; a future derivation change
 * needs a new label (and prefix), never an edit of this one. The hash is
 * namespaced by `(agent, instanceId)` because the submission store is shared
 * across all agents and instances — the same channel event id fanned out to
 * two instances must not collide. The transport kind is deliberately
 * EXCLUDED: the same key arriving on both transports must surface as a loud
 * row-kind conflict, never a silent duplicate turn.
 */
export async function deriveKeyedSubmissionId(
	agent: string,
	id: string,
	idempotencyKey: string,
): Promise<string> {
	const preimage = `flue-submission-key\n${agent}\n${id}\n${idempotencyKey}`;
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage));
	const hex = [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	return `sub_ik_${hex.slice(0, 32)}`;
}

/**
 * Whether a submission id was derived from a caller idempotency key. Only
 * {@link deriveKeyedSubmissionId} mints the `sub_ik_` prefix (submission ids
 * are server-minted, never caller-supplied), so the prefix is the durable
 * keyed-admission marker both coordinators branch on for replay adoption —
 * nothing extra rides the dispatch wire or the persisted payload.
 */
export function isKeyDerivedSubmissionId(submissionId: string): boolean {
	return submissionId.startsWith('sub_ik_');
}

export function generateAttemptId(): string {
	return `attempt_${ulid()}`;
}

/**
 * A synthesized tool-call id for calls with no model turn behind them:
 * `session.shell()` executions recorded as tool events, and standalone/eval
 * runs through `parseToolInput` with no session facilities. Inside a session
 * a tool's `ToolContext.toolCallId` is the real provider-minted id instead,
 * so it always matches the call's emitted events.
 */
export function generateToolCallId(): string {
	return `call_${ulid()}`;
}

/**
 * Correlation ref minted when the HTTP error renderer writes a server-side
 * log line. The same value rides the wire envelope (`error.ref`), the
 * `flue-error-ref` response header, and the log-line prefix — never persisted,
 * so a ref is a promise of a matching log line, not a durable resource. ULID
 * ordering lets an operator bracket the log window from the ref alone.
 */
export function generateErrorRef(): string {
	return `err_${ulid()}`;
}

/** Per-process producer identity for conversation-stream ownership. */
export function generateOwnerId(): string {
	return `owner_${ulid()}`;
}

/** Per-creation stream incarnation marker (adapters mint the same shape). */
export function generateIncarnationId(): string {
	return `inc_${ulid()}`;
}
