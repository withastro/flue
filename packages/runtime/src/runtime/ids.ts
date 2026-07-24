import { ulid } from 'ulidx';

export function generateSessionAffinityKey(): string {
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

/** Per-process producer identity for conversation-stream ownership. */
export function generateOwnerId(): string {
	return `owner_${ulid()}`;
}

/** Per-creation stream incarnation marker (adapters mint the same shape). */
export function generateIncarnationId(): string {
	return `inc_${ulid()}`;
}
