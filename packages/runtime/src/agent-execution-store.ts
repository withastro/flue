/**
 * Shared agent execution store interface.
 *
 * Both Cloudflare (DO SQLite) and Node (node:sqlite :memory:) implement this
 * contract using the same underlying SQL store. The interface is target-neutral
 * so that future persistent backends (Postgres, MySQL, Turso, etc.) can
 * implement it directly.
 */

import type { SubmissionSettledRecord } from './conversation-records.ts';
import type { AgentSubmissionInput } from './runtime/agent-submissions.ts';
import type { AttachmentStore } from './runtime/attachment-store.ts';
import type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';
import type { DispatchInput } from './runtime/dispatch-queue.ts';

// ─── Durability defaults ────────────────────────────────────────────────────

/** Default maximum total attempts before terminalization. */
export const DURABILITY_DEFAULT_MAX_ATTEMPTS = 10;
/** Default submission timeout in milliseconds (one hour). */
export const DURABILITY_DEFAULT_TIMEOUT_MS = 3_600_000;
/** Default lease duration for submission ownership in milliseconds (30 seconds). */
export const LEASE_DURATION_MS = 30_000;

// ─── Submission ─────────────────────────────────────────────────────────────

/**
 * Submission lifecycle states. The linear path is
 * `queued → running → (terminalizing →) settled`. The join pair models a
 * queued dispatch delivery being absorbed into another submission's live
 * response at a turn boundary (dispatch-while-busy): `joining` is the durable
 * intent (claimed by the host's session, canonical input record not yet
 * confirmed), `joined` means the delivery's input is durably part of the
 * host's response. Joined submissions settle with their host — see
 * {@link AgentSubmissionStore.completeSubmission}.
 *
 * One-truth-per-fact contract (which store answers which question):
 *
 * - **Terminal state is a cache of the stream.** A submission's outcome is
 *   durably encoded by its conversation stream's `submission_settled` record;
 *   the settled row (status/error) is a projection of it, and the stream wins
 *   on disagreement. Mid-settlement crashes leave `terminalizing` rows with a
 *   reserved record that the coordinators finish on wake; ledger-level
 *   divergence (a store restored from backup) is converged by
 *   `rebuildSettledSubmissionRows`, which re-derives terminal rows from the
 *   streams through the normal reservation machinery.
 * - **Coordination fields are lossy, never history.** Leases, attempt ids and
 *   counts, markers, and the abort request stamp exist to elect and
 *   fence a writer; each converges by its own rule after a crash (lease
 *   expiry + reconcile scan, marker staleness + startup reconcile, requests
 *   consumed-or-expire). No code may read a coordination field as historical
 *   truth — history questions go to the stream. `inputAppliedAt` in
 *   particular is the durability stamp's bookkeeping, never
 *   input-appliedness.
 * - **The ledger's own truths** are the pre-stream facts: the admitted
 *   payload and queue ordering (admission precedes the conversation's
 *   existence) and the once-stamped durability budget (`maxAttempts`/
 *   `timeoutAt`, installed at first input application so retries never
 *   re-anchor it).
 */
type AgentSubmissionStatus =
	'queued' | 'running' | 'terminalizing' | 'settled' | 'joining' | 'joined';

export interface AgentSubmission {
	readonly sequence: number;
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly kind: 'dispatch' | 'direct';
	readonly input: AgentSubmissionInput;
	readonly status: AgentSubmissionStatus;
	readonly acceptedAt: number;
	readonly canonicalReadyAt: number | null;
	readonly attemptId?: string;
	readonly inputAppliedAt?: number;
	/**
	 * When set, abort was requested for this submission. This is a durable
	 * abort+recovery *signal*, NOT a terminal classification: the aborted
	 * outcome is read only from the settlement (a `submission_aborted` advisory,
	 * plus a direct `submission_settled` record with `outcome: 'aborted'`). A
	 * submission that completes or fails while this is set still settles
	 * completed/failed — the flag merely tells the owning attempt to stop and
	 * tells recovery to settle aborted rather than retry. May be present while
	 * `queued` (an abort arrived before the submission was ever claimed).
	 */
	readonly abortRequestedAt?: number;
	readonly startedAt?: number;
	/**
	 * The host submission this delivery joined (status `joining`/`joined`,
	 * and preserved on the settled row for inspection). A joined delivery's
	 * input became part of the host's live response instead of waking its
	 * own; it consumes no attempts of its own and settles with the host's
	 * outcome.
	 */
	readonly joinedInto?: string;
	readonly error?: string;
	/** Epoch-ms when the submission reached a terminal `settled` state; undefined until then. */
	readonly settledAt?: number;
	readonly attemptCount: number;
	readonly maxAttempts: number;
	readonly timeoutAt: number;
	readonly ownerId?: string;
	readonly leaseExpiresAt: number;
}

export interface SubmissionSettlementObligation {
	readonly submissionId: string;
	readonly sessionKey: string;
	readonly attemptId: string;
	readonly recordId: string;
	readonly record: SubmissionSettledRecord;
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
	readonly maxAttempts: number;
	readonly timeoutAt: number;
}

// ─── Dispatch admission ─────────────────────────────────────────────────────

export type AgentDispatchAdmission =
	| { readonly kind: 'submission'; readonly submission: AgentSubmission }
	| { readonly kind: 'conflict' };

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
 * Stability: the lease method group mirrors the durable-execution engine and
 * is subject to change until 1.0. This applies to every backend equally.
 */
export interface AgentSubmissionStore {
	// Query
	/** Return the submission, or `null` when the id is unknown. */
	getSubmission(submissionId: string): Promise<AgentSubmission | null>;
	/** True while any submission is queued, running, or joining/joined. */
	hasUnsettledSubmissions(): Promise<boolean>;
	/**
	 * Queued submissions that are each the oldest unsettled submission of
	 * their session, in admission order. At most one runnable head exists
	 * per session; later queued work in the same session is excluded until
	 * everything admitted before it has settled. `joining`/`joined` rows
	 * count as unsettled here (they block later queued work exactly like a
	 * running head; the settle fan-out clears them with their host).
	 */
	listRunnableSubmissions(): Promise<AgentSubmission[]>;
	/** All queued submissions without canonical readiness, in admission order. */
	listUnreadySubmissions(): Promise<AgentSubmission[]>;
	/** All running submissions, in admission order. */
	listRunningSubmissions(): Promise<AgentSubmission[]>;
	/** Direct settlement obligations reserved but not yet finalized. */
	listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]>;

	/**
	 * Recovery handoff: atomically move a running submission from `attempt`
	 * to `nextAttemptId`, increment `attemptCount`, and (when given) install
	 * the new lease. `abortRequestedAt` must survive the replacement so a
	 * pending abort settles the submission instead of retrying it. Returns
	 * the updated submission, or `null` — without writing — when the
	 * submission is not running under `attempt`.
	 */
	replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null>;

	// Admission
	/**
	 * Idempotent admission keyed by submission id. An exact replay (same id,
	 * same payload) returns the already-admitted submission; the same id
	 * with a different payload returns `conflict`.
	 */
	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
	/**
	 * Admit a direct prompt (`input.kind === 'direct'`) as a queued submission.
	 * Idempotent for an exact replay of the same submission id and payload.
	 */
	admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission>;
	/**
	 * Mark a newly admitted queued submission's canonical conversation as materialized.
	 * Idempotent while queued; returns `null` when the submission is missing or no longer queued.
	 */
	markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null>;

	// Submission lifecycle
	/**
	 * Atomic compare-and-set. Transition the submission from queued to
	 * running ONLY when it is currently queued and is the runnable head of
	 * its session (no earlier unsettled submission in the same session),
	 * recording the attempt id, owner, lease expiry, and start time,
	 * incrementing `attemptCount`, resetting `maxAttempts` to the system
	 * default, and initializing `timeoutAt` when still unset (a previously
	 * initialized timeout is preserved across requeue/reclaim). Returns the
	 * claimed submission, or `null` when any condition fails. Two concurrent
	 * claims for the same submission must never both succeed.
	 */
	claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
	/**
	 * Install the session-resolved durability budget (or defaults) once, at
	 * first input application, stamping `inputAppliedAt` as the once-guard.
	 * Gated on a running submission owned by `attempt`; otherwise `false`.
	 *
	 * The timestamp is the durability stamp's own bookkeeping, NOT the truth
	 * about input application — the canonical stream is the single truth for
	 * that (a persisted input entry classifies and resumes; an absent one
	 * requeues). No decision may read `inputAppliedAt` as "was the input
	 * persisted".
	 */
	markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: SubmissionDurability,
	): Promise<boolean>;
	/**
	 * Record an abort request for every unsettled submission in a session.
	 * Atomically stamps `abortRequestedAt` (COALESCE — first request wins) on
	 * each `queued`, `running`, `joining`, or `joined` submission with the given `sessionKey` and
	 * returns their submission ids. It does NOT settle anything and does NOT
	 * change `status`: terminal settlement always happens through an
	 * attempt-based path (the pre-execution abort check when a queued submission
	 * is claimed, the in-flight abort settle, or the recovery abort branch) so a
	 * durable canonical terminal record always exists. `terminalizing` and
	 * `settled` submissions are left untouched (a committed outcome must not be
	 * overridden). Idempotent; returns an empty array when nothing is unsettled.
	 */
	requestSessionAbort(sessionKey: string): Promise<string[]>;
	/**
	 * Return a running submission to queued for a clean first attempt —
	 * clearing its attempt, owner, lease, and durability stamp (a requeued
	 * submission re-stamps at its next input application) — gated only on
	 * `attempt` owning the running submission; otherwise `false`. WHEN to
	 * requeue is the caller's judgment against the canonical stream
	 * (reconciliation requeues only when the submission's input entry is
	 * absent — the stream is the single truth for input application); the
	 * store does not second-guess it from operational fields.
	 */
	requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
	/**
	 * Atomically reserve the exact canonical settlement record as an obligation.
	 * Two shapes may transition to terminalizing, for either submission kind: a
	 * running submission owned by `attempt`, or a delivery `joined` into a host
	 * running under `attempt.attemptId` — the host settles the joined waiter's
	 * record under its own authority, adopting the row's `attemptId`/`startedAt`.
	 * Exact retries return the existing obligation; conflicting record
	 * identities or payloads return `null`.
	 */
	reserveSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		settlement: { recordId: string; record: SubmissionSettledRecord },
	): Promise<SubmissionSettlementObligation | null>;
	/**
	 * Finalize an owned terminalizing submission after its canonical record
	 * exists. The row's error column mirrors the settlement outcome:
	 * `options.errorMessage` (the raw server-side message) when the caller has
	 * it, else the record's client-safe error message, else null on success.
	 */
	finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
		options?: { errorMessage?: string },
	): Promise<boolean>;
	/**
	 * Settle the submission successfully. Gated on a running submission
	 * owned by `attempt`: a stale attempt or an already-settled submission
	 * returns `false` and preserves the first terminal state.
	 *
	 * Joined-delivery fan-out (applies equally to {@link failSubmission} and
	 * {@link finalizeSubmissionSettlement}): settling a host atomically
	 * settles every `joined` submission attached to it (`joinedInto` equals
	 * the host's id) with the same outcome — success here, the host's error
	 * on failure. Any `joining` stragglers (a join whose canonical input was
	 * never confirmed — an abort or crash window) atomically revert to
	 * `queued` instead, so the delivery runs as its own submission rather
	 * than silently vanishing with a response that never carried it.
	 *
	 * Joined DIRECT deliveries normally never reach this fan-out: the
	 * processing layer settles each one through the settlement outbox (its
	 * durable `submission_settled` record, reserved via
	 * {@link reserveSubmissionSettlement} under the host attempt) BEFORE
	 * settling the host, so HTTP waiters always observe an outcome record.
	 * The fan-out remains the kind-agnostic backstop: a joined row of either
	 * kind still present when the host settles is cleared here rather than
	 * wedging the session queue.
	 */
	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
	/**
	 * Settle the submission with an error message. Same gating as
	 * {@link completeSubmission}: the first terminal state wins. Applies the
	 * same joined-delivery fan-out.
	 */
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;

	// Turn-boundary joins (dispatch-while-busy)
	/**
	 * Atomically claim queued deliveries for absorption into the host's live
	 * response. Gated on the host running under `host.attemptId` (a replaced
	 * or settled attempt claims nothing — zombie fencing). Claims the
	 * CONTIGUOUS prefix of the session's queued submissions — both kinds;
	 * dispatch and direct (HTTP) deliveries join alike — in admission order,
	 * stopping at the first row that is not joinable: not canonical-ready,
	 * not the same agent, or abort-requested. Stopping (rather than
	 * skipping) preserves admission order. Each claimed row transitions
	 * `queued → joining` with `joinedInto` set to the host; the claimed
	 * submissions are returned in admission order. Two concurrent claimers
	 * must never both claim the same row.
	 */
	claimJoinableSubmissions(
		host: SubmissionAttemptRef,
		agentName: string,
	): Promise<AgentSubmission[]>;
	/**
	 * Confirm a claimed join once the delivery's canonical input record is
	 * durable: `joining → joined`, stamping `inputAppliedAt` once. Gated on
	 * the row being `joining` into this host AND the host still running
	 * under `host.attemptId`; otherwise `false`.
	 */
	finalizeJoinedSubmission(host: SubmissionAttemptRef, submissionId: string): Promise<boolean>;
	/**
	 * Hand a claimed-but-unconfirmed join back to the queue:
	 * `joining → queued`, clearing `joinedInto`. Legal only while the
	 * delivery's canonical input record does NOT exist (the caller owns that
	 * check — reverting an applied join would duplicate the message). Same
	 * gating as {@link finalizeJoinedSubmission}; otherwise `false`.
	 */
	revertJoiningSubmission(host: SubmissionAttemptRef, submissionId: string): Promise<boolean>;
	/**
	 * Every unsettled join attached to the host (`joining` and `joined`), in
	 * admission order. Recovery uses this to resolve `joining` stragglers by
	 * canonical-record existence and to re-adopt `joined` deliveries' start
	 * hooks on a re-attempt.
	 */
	listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]>;

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
}

// ─── Persistence adapter ────────────────────────────────────────────────────

/** The complete set of stores a {@link PersistenceAdapter} provides. */
export interface PersistenceStores {
	/** Durable agent submission lifecycle storage. */
	readonly submissionStore: AgentSubmissionStore;
	/** Canonical per-agent-instance conversation streams. */
	readonly conversationStreamStore: ConversationStreamStore;
	/** Immutable attachment bytes referenced by canonical conversation records. */
	readonly attachmentStore: AttachmentStore;
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
