/**
 * Shared helpers for persistence adapter implementations.
 *
 * These pure functions are consumed by the built-in SQLite adapter, the
 * Postgres adapter (`@flue/postgres`), and any future community adapters
 * via `@flue/runtime/adapter`.
 *
 * All functions operate on plain values — no database driver types.
 */

import type { AgentSubmission } from './agent-execution-store.ts';
import { createSessionStorageKey } from './session-identity.ts';

/**
 * Agent-mode submissions (HTTP and dispatch) always target the
 * default harness. Named harnesses exist for multi-harness workflows
 * (`ctx.init(agent, { name: 'setup' })`), but external submissions do
 * not select a harness — they implicitly use `'default'`.
 *
 * Exported for adapter implementations that construct session storage keys.
 */
export const SUBMISSION_HARNESS_NAME = 'default';

// ─── Payload validation ─────────────────────────────────────────────────────

/**
 * Context needed for submission payload validation.
 *
 * Adapters extract these fields from their storage-specific row/document
 * type before calling {@link isSubmissionPayload}.
 */
export interface SubmissionPayloadContext {
	readonly kind: string;
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly acceptedAt: number;
}

/**
 * Validate that a parsed JSON payload matches the expected submission shape.
 *
 * Used after `JSON.parse(payload)` to verify the deserialized object is a
 * well-formed `AgentSubmissionInput` that is consistent with the stored
 * submission metadata.
 */
export function isSubmissionPayload(
	input: unknown,
	ctx: SubmissionPayloadContext,
): input is AgentSubmission['input'] {
	if (!input || typeof input !== 'object') return false;
	const value = input as Record<string, unknown>;
	if (value.kind !== ctx.kind || value.submissionId !== ctx.submissionId) return false;
	if (value.kind === 'dispatch') {
		return (
			typeof value.dispatchId === 'string' &&
			value.dispatchId === value.submissionId &&
			typeof value.agent === 'string' &&
			typeof value.id === 'string' &&
			typeof value.session === 'string' &&
			createSessionStorageKey(
				value.id as string,
				SUBMISSION_HARNESS_NAME,
				value.session as string,
			) === ctx.sessionKey &&
			typeof value.acceptedAt === 'string' &&
			Date.parse(value.acceptedAt as string) === ctx.acceptedAt &&
			'input' in value &&
			value.input !== undefined
		);
	}
	return (
		typeof value.agent === 'string' &&
		typeof value.id === 'string' &&
		typeof value.session === 'string' &&
		createSessionStorageKey(
			value.id as string,
			SUBMISSION_HARNESS_NAME,
			value.session as string,
		) === ctx.sessionKey &&
		typeof value.acceptedAt === 'string' &&
		Date.parse(value.acceptedAt as string) === ctx.acceptedAt &&
		isDirectPayload(value.payload)
	);
}

/** Validate that a value is a well-formed direct submission payload. */
function isDirectPayload(value: unknown): boolean {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
	const payload = value as { message?: unknown };
	return typeof payload.message === 'string';
}

// ─── Timestamp parsing ──────────────────────────────────────────────────────

/**
 * Parse an ISO timestamp string into epoch milliseconds.
 * Throws with a `[flue]` error if the value is not a finite number.
 */
export function parseAcceptedAt(value: string, label: string): number {
	const acceptedAt = Date.parse(value);
	if (!Number.isFinite(acceptedAt)) {
		throw new Error(`[flue] Internal ${label} received an invalid acceptedAt timestamp.`);
	}
	return acceptedAt;
}

// ─── Session deletion deduplication ─────────────────────────────────────────

/**
 * Deduplicate concurrent `deleteSession` calls for the same session key.
 *
 * If a deletion is already in progress for the given key, returns the
 * existing promise. Otherwise, calls `runDeletion` and tracks the result.
 * The tracking entry is removed after the promise settles (success or failure).
 */
export function deduplicateSessionDeletion(
	pending: Map<string, Promise<void>>,
	sessionKey: string,
	runDeletion: () => Promise<void>,
): Promise<void> {
	const existing = pending.get(sessionKey);
	if (existing) return existing;
	const deletion = runDeletion();
	pending.set(sessionKey, deletion);
	const clear = () => {
		if (pending.get(sessionKey) === deletion) {
			pending.delete(sessionKey);
		}
	};
	void deletion.then(clear, clear);
	return deletion;
}
