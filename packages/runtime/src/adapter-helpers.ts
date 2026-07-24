/**
 * Shared helpers for persistence adapter implementations.
 *
 * These pure functions are consumed by the built-in SQLite adapter, the
 * Postgres adapter (`@flue/postgres`), and any future community adapters
 * via `@flue/runtime/adapter`.
 *
 * All functions operate on plain values — no database driver types.
 */

import * as v from 'valibot';
import type { AgentDispatchAdmission, AgentSubmission } from './agent-execution-store.ts';
import type { SubmissionChunkRow } from './persisted-image-placement.ts';
import {
	matchesPersistedSubmissionAttachments,
	prepareSubmissionAttachments,
	sameSubmissionChunks,
} from './persisted-image-placement.ts';
import type { AgentSubmissionInput } from './runtime/agent-submissions.ts';
import { DeliveredMessageSchema } from './runtime/schemas.ts';
import { createSessionStorageKey } from './session-identity.ts';

/**
 * Agent-mode submissions (HTTP and dispatch) always target the
 * default harness. Named harnesses exist for multi-harness workflows
 * (for example, named internal scopes), but external submissions do
 * not select a harness — they implicitly use `'default'`.
 *
 * Exported for adapter implementations that construct session storage keys.
 */
export const SUBMISSION_HARNESS_NAME = 'default';

/**
 * Agent-mode submissions always target the default session of the
 * default harness; external submissions cannot select a session.
 *
 * Exported for adapter implementations that construct session storage keys.
 */
export const SUBMISSION_SESSION_NAME = 'default';

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
 * submission metadata. Both dispatch and direct payloads carry the same
 * `message: DeliveredMessage` field — validated identically here regardless
 * of transport `kind`.
 *
 * The `kind`/`submissionId`/`sessionKey`/`acceptedAt` cross-checks against
 * the row's own columns are load-bearing, not redundant: the payload is the
 * byte-exact admitted input and is the identity the session layer runs under
 * (it never sees the row). In backends that store the payload physically
 * apart from the row — MongoDB's chunked value generations, Redis's
 * per-generation hashes — the store's completeness checks cannot catch a
 * *complete but wrong* payload (a stale generation pointer, a backup mixing
 * two databases). This mismatch is the only thing that stops the runtime
 * executing one submission's message under another's identity: a failing
 * check terminalizes the row instead of running it.
 */
export function isSubmissionPayload(
	input: unknown,
	ctx: SubmissionPayloadContext,
): input is AgentSubmission['input'] {
	if (!input || typeof input !== 'object') return false;
	const value = input as Record<string, unknown>;
	if (value.kind !== ctx.kind || value.submissionId !== ctx.submissionId) return false;
	if (!v.safeParse(DeliveredMessageSchema, value.message).success) return false;
	return (
		typeof value.agent === 'string' &&
		typeof value.id === 'string' &&
		createSessionStorageKey(
			value.agent as string,
			value.id as string,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		) === ctx.sessionKey &&
		typeof value.acceptedAt === 'string' &&
		Date.parse(value.acceptedAt as string) === ctx.acceptedAt
	);
}

// ─── Submission admission ───────────────────────────────────────────────────

/**
 * Run a maybe-async continuation without forcing a promise: when `value` is a
 * plain value the continuation runs synchronously, so a fully synchronous
 * backend (e.g. Durable Object SQLite inside `transactionSync`) completes the
 * whole admission without ever yielding to the microtask queue.
 */
function chain<T, R>(value: T | Promise<T>, next: (value: T) => R | Promise<R>): R | Promise<R> {
	return value instanceof Promise ? value.then(next) : next(value);
}

/** The queued row that {@link admitSubmissionWithBackend} writes on first admission. */
export interface SubmissionInsertRow {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly payload: string;
	readonly acceptedAt: number;
}

/**
 * The minimal shape {@link admitSubmissionWithBackend} needs from a persisted
 * submission row: the transport `kind` and serialized `payload` it compares
 * against the incoming admission.
 */
export interface SubmissionAdmissionRow {
	readonly kind?: unknown;
	readonly payload?: unknown;
}

/**
 * Storage callbacks for {@link admitSubmissionWithBackend}.
 *
 * Every callback runs inside the transaction the caller has already opened.
 * Callbacks may return plain values (synchronous backends) or native
 * `Promise`s — non-native thenables are not supported.
 */
export interface SubmissionAdmissionBackend<Row extends SubmissionAdmissionRow> {
	/** Insert the queued submission row, ignoring a duplicate `submissionId`. */
	insertIfAbsent(row: SubmissionInsertRow): void | Promise<void>;
	/** Read back the submission row for `submissionId`, if present. */
	getExisting(submissionId: string): Row | undefined | Promise<Row | undefined>;
	/** Read the persisted attachment chunks for the submission. */
	readChunks(
		submissionId: string,
	): readonly SubmissionChunkRow[] | Promise<readonly SubmissionChunkRow[]>;
	/** Replace the persisted attachment chunks for the submission. */
	replaceChunks(submissionId: string, chunks: readonly SubmissionChunkRow[]): void | Promise<void>;
	/** Parse a persisted row (plus its attachment chunks) into an {@link AgentSubmission}. */
	parseSubmission(row: Row, chunks: readonly SubmissionChunkRow[]): AgentSubmission;
}

/**
 * Shared submission admission algorithm for row-oriented backends:
 * prepare attachments → insert-or-ignore → read-back → payload compare
 * (idempotent replay vs. conflict) → attachment-chunk adoption or comparison.
 *
 * The caller owns transaction scoping — invoke this inside one transaction
 * and pass callbacks bound to it. When every callback is synchronous the
 * result is returned synchronously, so the algorithm also fits synchronous
 * transaction wrappers such as Durable Object `transactionSync`.
 */
export function admitSubmissionWithBackend<Row extends SubmissionAdmissionRow>(
	input: AgentSubmissionInput,
	backend: SubmissionAdmissionBackend<Row>,
): AgentDispatchAdmission | Promise<AgentDispatchAdmission> {
	const { kind, submissionId } = input;
	const prepared = prepareSubmissionAttachments(input);
	const payload = JSON.stringify(prepared.value);
	const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
	const sessionKey = createSessionStorageKey(
		input.agent,
		input.id,
		SUBMISSION_HARNESS_NAME,
		SUBMISSION_SESSION_NAME,
	);
	const adopt = (row: Row): AgentDispatchAdmission | Promise<AgentDispatchAdmission> => {
		if (row.kind !== kind) return { kind: 'conflict' as const };
		if (row.payload !== payload) {
			// Serialized payloads differ, but the admission may still be an
			// idempotent replay once persisted attachment chunks are hydrated
			// back into the stored payload.
			return chain(backend.readChunks(submissionId), (persistedChunks) => {
				if (
					typeof row.payload !== 'string' ||
					!matchesPersistedSubmissionAttachments(
						input,
						JSON.parse(row.payload) as AgentSubmissionInput,
						persistedChunks,
					)
				) {
					return { kind: 'conflict' as const };
				}
				return {
					kind: 'submission' as const,
					submission: backend.parseSubmission(row, persistedChunks),
				};
			});
		}
		return chain(backend.readChunks(submissionId), (persistedChunks) => {
			if (persistedChunks.length === 0 && prepared.chunks.length > 0) {
				return chain(backend.replaceChunks(submissionId, prepared.chunks), () => ({
					kind: 'submission' as const,
					submission: backend.parseSubmission(row, prepared.chunks),
				}));
			}
			if (!sameSubmissionChunks(persistedChunks, prepared.chunks)) {
				return { kind: 'conflict' as const };
			}
			return {
				kind: 'submission' as const,
				submission: backend.parseSubmission(row, prepared.chunks),
			};
		});
	};

	return chain(
		backend.insertIfAbsent({ submissionId, sessionKey, kind, payload, acceptedAt }),
		() =>
			chain(backend.getExisting(submissionId), (row) => {
				if (!row) {
					throw new Error(`[flue] Durable ${kind} admission did not create a submission row.`);
				}
				return adopt(row);
			}),
	);
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

// ─── Limit clamping ──────────────────────────────────────────────────────────

/**
 * Clamp a caller-supplied page/chunk limit to a safe range.
 *
 * Invalid, non-finite, and non-positive values fall back to `defaultLimit`;
 * valid values are capped at `maxLimit`. Used by run listings
 * (`DEFAULT_LIST_LIMIT`/`MAX_LIST_LIMIT`) and event stream reads
 * (`DEFAULT_READ_LIMIT`/`MAX_READ_LIMIT`).
 */
export function clampLimit(
	limit: number | undefined,
	defaultLimit: number,
	maxLimit: number,
): number {
	if (!limit || !Number.isFinite(limit) || limit <= 0) return defaultLimit;
	return Math.min(limit, maxLimit);
}
