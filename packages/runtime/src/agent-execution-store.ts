/**
 * Shared agent execution store interface.
 *
 * Both Cloudflare (DO SQLite) and Node (node:sqlite :memory:) implement this
 * contract using the same underlying SQL store. The interface is target-neutral
 * so that future persistent backends (Postgres, MySQL, Turso, etc.) can
 * implement it directly.
 */

import type {
	AgentSubmissionInput,
	DirectAgentSubmissionInput,
} from './runtime/agent-submissions.ts';
import type {
	ConversationSnapshotStore,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';
import type { EventStreamStore } from './runtime/event-stream-store.ts';
import type { RunStore } from './runtime/run-store.ts';
import type { SessionStore } from './types.ts';

// ─── Durability defaults ────────────────────────────────────────────────────

/** Default maximum total attempts before terminalization. */
export const DURABILITY_DEFAULT_MAX_ATTEMPTS = 10;
/** Default submission timeout in milliseconds (one hour). */
export const DURABILITY_DEFAULT_TIMEOUT_MS = 3_600_000;
/** Default lease duration for submission ownership in milliseconds (30 seconds). */
export const LEASE_DURATION_MS = 30_000;

// ─── Submission ─────────────────────────────────────────────────────────────

type AgentSubmissionStatus = 'queued' | 'running' | 'terminalizing' | 'settled';

export interface AgentSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly input: AgentSubmissionInput;
	readonly status: AgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly attemptId?: string;
	readonly inputAppliedAt?: number;
	readonly recoveryRequestedAt?: number;
	readonly startedAt?: number;
	readonly error?: string;
	readonly attemptCount: number;
	readonly maxRetry: number;
	readonly timeoutAt: number;
	readonly ownerId?: string;
	readonly leaseExpiresAt: number;
}

export interface SubmissionTerminalOutbox {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly attemptId: string;
	readonly eventKey: string;
	readonly event: unknown;
	readonly offset?: string;
}

export interface SubmissionAttemptRef {
	readonly submissionId: string;
	readonly attemptId: string;
}

export interface SubmissionClaimRef extends SubmissionAttemptRef {
	readonly ownerId: string;
	readonly leaseExpiresAt: number;
}

export interface SubmissionDurability {
	readonly maxRetry: number;
	readonly timeoutAt: number;
}

/**
 * Flue-owned durable evidence that a submission attempt was started and has
 * not yet settled. The Cloudflare coordinator inserts a marker immediately
 * before starting an attempt fiber and deletes it when the attempt settles;
 * reconciliation treats a fresh marker as proof that the attempt may still
 * be running and must not be reconciled as interrupted.
 */
export interface AgentAttemptMarker {
	readonly submissionId: string;
	readonly attemptId: string;
	readonly createdAt: number;
}

// ─── Dispatch admission ─────────────────────────────────────────────────────

export interface AgentDispatchReceipt {
	readonly submissionId: string;
	readonly acceptedAt: number;
}

export type AgentDispatchAdmission =
	| { readonly kind: 'submission'; readonly submission: AgentSubmission }
	| { readonly kind: 'retained_receipt'; readonly receipt: AgentDispatchReceipt }
	| { readonly kind: 'conflict' };

// ─── Turn journal ───────────────────────────────────────────────────────────

export type AgentTurnJournalPhase =
	| 'before_provider'
	| 'provider_started'
	| 'tool_request_recorded'
	| 'committed';

export interface AgentTurnJournal {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly phase: AgentTurnJournalPhase;
	readonly revision: number;
	readonly createdAt: number;
	readonly updatedAt: number;
	readonly checkpointLeafId?: string;
	readonly toolRequest?: unknown;
	readonly streamKey?: string;
	readonly streamConsumedAt?: number;
	readonly committed: boolean;
	readonly committedLeafId?: string;
}

export interface CreateTurnJournalInput {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly attemptId: string;
	readonly operationId: string;
	readonly turnId: string;
	readonly phase: AgentTurnJournalPhase;
	readonly checkpointLeafId?: string;
	readonly toolRequest?: unknown;
}

// ─── Submission store ───────────────────────────────────────────────────────

/**
 * Durable submission lifecycle storage.
 *
 * This is one contract for every backend — there are no SQL-only or
 * "expert" tiers. The per-method invariants below are written in terms of
 * observable behavior, not storage primitives, so a non-SQL backend
 * (MongoDB, a key-value store) implements them natively. Where a method is
 * described as atomic, concurrent callers must never both observe success;
 * whether that is achieved with transactions, conditional updates, or
 * unique indexes is the adapter's choice. Verify an implementation with
 * `defineStoreContractTests` from `@flue/runtime/test-utils`.
 *
 * Stability: the turn-journal, stream-chunk, and lease method groups (and
 * the {@link AgentTurnJournalPhase} union) mirror the durable-execution
 * engine and are subject to change until 1.0. This applies to every
 * backend equally.
 */
export interface AgentSubmissionStore {
	// Query
	/** Return the submission, or `null` when the id is unknown. */
	getSubmission(submissionId: string): Promise<AgentSubmission | null>;
	/** Return the submission's turn journal, or `null` when none was ever begun. */
	getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null>;
	/** True while any submission is queued or running. */
	hasUnsettledSubmissions(): Promise<boolean>;
	/**
	 * Queued submissions that are each the oldest unsettled submission of
	 * their session, in admission order. At most one runnable head exists
	 * per session; later queued work in the same session is excluded until
	 * everything admitted before it has settled.
	 */
	listRunnableSubmissions(): Promise<AgentSubmission[]>;
	/** All running submissions, in admission order. */
	listRunningSubmissions(): Promise<AgentSubmission[]>;
	/** Direct terminal events reserved for durable publication but not yet finalized. */
	listPendingTerminalOutboxes(): Promise<SubmissionTerminalOutbox[]>;

	// Turn journal lifecycle. Each submission has at most ONE journal slot.
	/**
	 * Create the submission's journal, or replace an existing one in place:
	 * the new turn's identity and phase are written, stream and commit state
	 * are reset, and the revision increases. Returns whether a journal was
	 * written.
	 */
	beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean>;
	/**
	 * Advance the phase of the uncommitted journal owned by `attempt`,
	 * merging any provided options into the journal (absent options keep
	 * their stored values). Returns `false` — without writing — when the
	 * journal is missing, already committed, or owned by another attempt.
	 */
	updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options?: {
			checkpointLeafId?: string;
			toolRequest?: unknown;
			streamKey?: string;
		},
	): Promise<boolean>;
	/**
	 * Transition the journal to `committed`, recording `committedLeafId`.
	 * Only an UNCOMMITTED journal owned by `attempt` transitions; a second
	 * commit, a stale attempt, or a missing journal returns `false` and
	 * leaves the stored commit untouched.
	 */
	commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): Promise<boolean>;
	/**
	 * Stamp the journal's stream-consumed timestamp at most once. Succeeds
	 * only when the uncommitted journal is owned by `attempt`, stores the
	 * same `streamKey`, and has not been marked before; otherwise `false`.
	 */
	markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean>;
	/**
	 * Recovery handoff: atomically move a running submission and its
	 * uncommitted journal from `attempt` to `nextAttemptId`, increment
	 * `attemptCount`, clear any pending recovery request, and (when given)
	 * install the new lease. Returns the updated submission, or `null` —
	 * without writing — when the submission is not running under `attempt`.
	 */
	replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null>;

	// Stream chunks
	/**
	 * Insert a segment keyed by (`streamKey`, `segmentIndex`). When that key
	 * already exists, return `false` WITHOUT overwriting the stored body.
	 */
	appendStreamChunkSegment(streamKey: string, segmentIndex: number, body: string): Promise<boolean>;
	/** All segments for the stream, ordered by `segmentIndex` ascending. */
	getStreamChunkSegments(streamKey: string): Promise<Array<{ segmentIndex: number; body: string }>>;
	/** Remove every segment for the stream; a no-op when none exist. */
	deleteStreamChunkSegments(streamKey: string): Promise<void>;

	// Admission
	/**
	 * Idempotent admission keyed by dispatch id. An exact replay (same id,
	 * same payload) returns the already-admitted submission; the same id
	 * with a different payload returns `conflict`; an id whose settled row
	 * was removed by session deletion returns its retained receipt. Throws
	 * while the target session is being deleted.
	 */
	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
	/**
	 * Admit a direct prompt as a queued submission. Idempotent for an exact
	 * replay of the same submission id and payload. Throws while the target
	 * session is being deleted.
	 */
	admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission>;

	// Submission lifecycle
	/**
	 * Atomic compare-and-set. Transition the submission from queued to
	 * running ONLY when it is currently queued and is the runnable head of
	 * its session (no earlier unsettled submission in the same session),
	 * recording the attempt id, owner, lease expiry, and start time,
	 * incrementing `attemptCount`, resetting `maxRetry` to the system
	 * default, and initializing `timeoutAt` when still unset (a previously
	 * initialized timeout is preserved across requeue/reclaim). Returns the
	 * claimed submission, or `null` when any condition fails. Two concurrent
	 * claims for the same submission must never both succeed.
	 */
	claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
	/**
	 * Record once that the submission's input was canonically applied,
	 * installing the supplied durability (or defaults) on first application.
	 * Gated on a running submission owned by `attempt`; otherwise `false`.
	 */
	markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: SubmissionDurability,
	): Promise<boolean>;
	/**
	 * Stamp `recoveryRequestedAt` once. Gated on a running submission owned
	 * by `attempt`; otherwise `false`.
	 */
	requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean>;
	/**
	 * Return a running submission to queued — clearing its attempt, owner,
	 * and lease — ONLY while input has not been applied and `attempt` owns
	 * the submission; otherwise `false`.
	 */
	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean>;
	/**
	 * Atomically reserve the canonical decorated terminal event for publication.
	 * Only a running direct submission owned by `attempt` may transition to
	 * terminalizing. Exact retries return the existing reservation; conflicting
	 * terminal payloads return `null`.
	 */
	reserveSubmissionTerminal(
		attempt: SubmissionAttemptRef,
		terminal: { eventKey: string; event: unknown },
	): Promise<SubmissionTerminalOutbox | null>;
	/** Record the append offset for an owned terminalizing reservation. */
	recordSubmissionTerminalOffset(
		attempt: SubmissionAttemptRef,
		eventKey: string,
		offset: string,
	): Promise<boolean>;
	/** Finalize an owned terminalizing submission after its event was appended. */
	finalizeSubmissionTerminal(attempt: SubmissionAttemptRef, eventKey: string): Promise<boolean>;
	/**
	 * Settle the submission successfully. Gated on a running submission
	 * owned by `attempt`: a stale attempt or an already-settled submission
	 * returns `false` and preserves the first terminal state.
	 */
	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
	/**
	 * Settle the submission with an error message. Same gating as
	 * {@link completeSubmission}: the first terminal state wins.
	 */
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;

	// Attempt markers
	/**
	 * Durably record that the attempt was started. Idempotent: re-inserting
	 * the same (submissionId, attemptId) keeps the original `createdAt`.
	 */
	insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
	/** Delete the marker matching both ids exactly; a no-op when absent. */
	deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
	/** All attempt markers. */
	listAttemptMarkers(): Promise<AgentAttemptMarker[]>;

	// Lease management
	/**
	 * Extend the lease expiry (now + `LEASE_DURATION_MS`) for each listed
	 * submission that is running AND owned by `ownerId`. Submissions owned
	 * by another coordinator, settled, or unknown are silently skipped.
	 */
	renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
	/**
	 * Running submissions whose lease has expired (a positive
	 * `leaseExpiresAt` in the past). Queued and settled submissions are
	 * never returned.
	 */
	listExpiredSubmissions(): Promise<AgentSubmission[]>;

	// Deletion
	/**
	 * Delete all settled submission state for the session. Three phases:
	 * (1) reject when any submission in the session is queued, running, or terminalizing,
	 * else durably write a deletion marker that blocks new admissions;
	 * (2) invoke `deleteSessionTree` (the runtime's snapshot deletion) —
	 * when it throws, remove the marker so the session returns to a usable
	 * state and rethrow; (3) retain a receipt for each settled dispatch
	 * admitted before the marker, remove those submissions and their
	 * journals/chunks, then remove the marker. Concurrent calls for the
	 * same session key share one in-flight deletion.
	 */
	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
	/**
	 * List session keys with a durable deletion marker (deletion started but
	 * never completed, e.g. the process crashed mid-deletion). Coordinators
	 * resume these at startup by calling {@link deleteSession} again —
	 * otherwise the marker blocks all admissions for the session forever.
	 */
	listPendingSessionDeletions(): Promise<string[]>;
}

// ─── Execution store ────────────────────────────────────────────────────────

export interface AgentExecutionStore {
	readonly sessions: SessionStore;
	readonly submissions: AgentSubmissionStore;
}

// ─── Persistence adapter ────────────────────────────────────────────────────

/** The complete set of stores a {@link PersistenceAdapter} provides. */
export interface PersistenceStores {
	/** Agent session snapshots and durable submission lifecycle storage. */
	readonly executionStore: AgentExecutionStore;
	/** Workflow run records, lookup, and listing. */
	readonly runStore: RunStore;
	/** Durable append-only event streams for agents and workflow runs. */
	readonly eventStreamStore: EventStreamStore;
	/** Canonical per-agent-instance conversation streams. */
	readonly conversationStreamStore: ConversationStreamStore;
	/** Disposable materialized caches for canonical conversation streams. */
	readonly conversationSnapshotStore: ConversationSnapshotStore;
}

/**
 * A persistence adapter provides the {@link PersistenceStores} bundle backed
 * by a specific database. Users configure persistence by creating a `db.ts`
 * file in their source root and default-exporting an adapter.
 *
 * Adapter packages export a factory function that returns this interface.
 * The built-in `sqlite()` adapter is available from `@flue/runtime/node`.
 *
 * Lifecycle: the framework calls `migrate()` (if present) once at startup
 * to bring the store to the current schema/format version, then awaits
 * `connect()` once to obtain every store — an unreachable or misconfigured
 * database fails at boot, not inside the first request. On shutdown,
 * `close()` is called to release resources.
 *
 * Versioning obligation (storage-agnostic): an adapter durably records its
 * schema/format version when it first creates the store, and fails loudly —
 * before reading or writing any data — when opened against a store recorded
 * with an unknown or newer version (e.g. throw
 * `PersistedSchemaVersionError`, exported from `@flue/runtime/adapter`).
 * The built-in SQL adapters implement this with a one-row `flue_meta`
 * key/value table (key `'schema_version'`); non-SQL adapters implement the
 * same obligation natively (a key, a meta document, etc.).
 */
export interface PersistenceAdapter {
	/**
	 * Open the database and return every store. Awaited once at startup, so
	 * async pool setup, remote handshakes, and — for adapters without
	 * {@link migrate} — the schema-version check belong here.
	 */
	connect(): PersistenceStores | Promise<PersistenceStores>;
	/**
	 * Bring the store to the current schema/format version.
	 * Called once at startup before {@link connect}. Creates any missing
	 * schema, durably records the schema/format version when the store is
	 * first created, and fails loudly when the store records an unknown or
	 * newer version. Adapters that create schema implicitly (e.g. LMDB) may
	 * omit this method, but must still uphold the versioning obligation in
	 * their store-creating paths.
	 */
	migrate?(): void | Promise<void>;
	/** Gracefully release resources (connection pools, file handles). */
	close?(): void | Promise<void>;
}
