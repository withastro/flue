---
title: Data Persistence API
description: The persistence adapter contract — PersistenceAdapter, the three store interfaces, the cross-cutting storage rules, and the contract test suites.
lastReviewedAt: 2026-07-21
---

A persistence adapter backs Flue's durable state with a specific database. This page documents the adapter contract: the `PersistenceAdapter` interface, the three store interfaces its `connect()` returns, the storage rules every backend must uphold, and the contract test suites that verify an implementation. Types and helpers are exported from `@flue/runtime/adapter`; the test suites from `@flue/runtime/test-utils`. For configuring a database in a project (`db.ts`, the in-memory default, ecosystem adapters), see [Database](/docs/guide/database/); for what the durable-execution engine does with this storage, see [Durability](/docs/guide/durability/).

There is one adapter contract for every backend — no SQL-only or "expert" tiers. Method invariants are stated as observable behavior, not storage primitives, so non-SQL backends are first-class implementations. The exported types carry exhaustive per-method docblocks, and the [contract test suites](#contract-test-suites) are the executable specification; an adapter is correct when all three suites pass. If this page and the package differ, the package wins.

The adapter surface is Node-only: on the Cloudflare target every agent instance persists in its Durable Object's built-in SQLite storage, a `db.ts` file is rejected at build time, and custom adapters do not apply. Stability: the `AgentSubmissionStore` settlement and lease method groups mirror the durable-execution engine and are subject to change until 1.0, for every backend equally.

## `PersistenceAdapter`

```ts
interface PersistenceAdapter {
  connect(): PersistenceStores | Promise<PersistenceStores>;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

Adapter packages export a factory function returning this interface; users default-export the result from `db.ts`. The built-in reference implementation is `sqlite(path?: string)` from `@flue/runtime/node`.

- `connect()` — open the database and return every store. Awaited once at startup, so async pool setup, remote handshakes, and — for adapters without `migrate` — the schema-version check belong here. An unreachable database fails at boot, not inside the first request.
- `migrate()` — bring the store to the current schema/format version. Called once at startup, before `connect()`. Creates any missing schema, durably records the schema version when the store is first created, and fails loudly when the store records an unknown or newer version. Adapters that create schema implicitly may omit it, but must uphold the versioning obligation in their store-creating paths.
- `close()` — release resources (connection pools, file handles). Called on shutdown.

## `PersistenceStores`

```ts
interface PersistenceStores {
  readonly submissionStore: AgentSubmissionStore;
  readonly conversationStreamStore: ConversationStreamStore;
  readonly attachmentStore: AttachmentStore;
}
```

- `submissionStore` — durable submission lifecycle storage.
- `conversationStreamStore` — canonical per-agent-instance conversation streams.
- `attachmentStore` — immutable attachment bytes referenced by canonical conversation records.

## `AgentSubmissionStore`

The durable submission ledger: admitted payloads, queue ordering, attempt/lease coordination, and settlement projections. Submission status follows `queued → running → (terminalizing →) settled`, with a `joining`/`joined` pair for queued deliveries absorbed into another submission's live response at a turn boundary. Sessions are append-only for the life of the agent instance; the contract has no per-session deletion. Every method's full invariants live in the docblocks on the exported type.

```ts
interface AgentSubmissionStore {
  // Query
  getSubmission(submissionId: string): Promise<AgentSubmission | null>;
  hasUnsettledSubmissions(): Promise<boolean>;
  listRunnableSubmissions(): Promise<AgentSubmission[]>;
  listUnreadySubmissions(): Promise<AgentSubmission[]>;
  listRunningSubmissions(): Promise<AgentSubmission[]>;
  listPendingSubmissionSettlements(): Promise<SubmissionSettlementObligation[]>;
  replaceSubmissionAttempt(
    attempt: SubmissionAttemptRef,
    nextAttemptId: string,
    lease?: { ownerId: string; leaseExpiresAt: number },
  ): Promise<AgentSubmission | null>;
  // Admission
  admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
  admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission>;
  markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null>;
  // Lifecycle
  claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
  markSubmissionInputApplied(
    attempt: SubmissionAttemptRef,
    durability?: SubmissionDurability,
  ): Promise<boolean>;
  requestSessionAbort(sessionKey: string): Promise<string[]>;
  requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  reserveSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    settlement: { recordId: string; record: SubmissionSettledRecord },
  ): Promise<SubmissionSettlementObligation | null>;
  finalizeSubmissionSettlement(
    attempt: SubmissionAttemptRef,
    recordId: string,
    options?: { errorMessage?: string },
  ): Promise<boolean>;
  completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;
  // Turn-boundary joins
  claimJoinableSubmissions(
    host: SubmissionAttemptRef,
    agentName: string,
  ): Promise<AgentSubmission[]>;
  finalizeJoinedSubmission(host: SubmissionAttemptRef, submissionId: string): Promise<boolean>;
  revertJoiningSubmission(host: SubmissionAttemptRef, submissionId: string): Promise<boolean>;
  listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]>;
  // Lease management
  renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
  listExpiredSubmissions(): Promise<AgentSubmission[]>;
}
```

The supporting types — `AgentSubmission`, `SubmissionAttemptRef`, `SubmissionClaimRef`, `SubmissionDurability`, `SubmissionSettlementObligation`, `AgentDispatchAdmission`, `AgentDispatchReceipt`, `AgentSubmissionInput`, and `DispatchInput` — are all exported from `@flue/runtime/adapter`.

Query methods:

- `getSubmission` — the submission, or `null` when the id is unknown.
- `hasUnsettledSubmissions` — `true` while any submission is queued, running, or joining/joined.
- `listRunnableSubmissions` — queued submissions that are each the oldest unsettled submission of their session, in admission order; at most one runnable head exists per session.
- `listUnreadySubmissions` — queued submissions without canonical readiness, in admission order.
- `listRunningSubmissions` — all running submissions, in admission order.
- `listPendingSubmissionSettlements` — settlement obligations reserved but not yet finalized.
- `replaceSubmissionAttempt` — recovery handoff: atomically move a running submission to a new attempt id, increment `attemptCount`, and install the new lease when given; `null` without writing when the submission is not running under `attempt`.

Admission methods:

- `admitDispatch` — idempotent admission keyed by submission id: an exact replay returns the already-admitted submission, the same id with a different payload returns `{ kind: 'conflict' }`, and an id matching a retained receipt returns `{ kind: 'retained_receipt' }` without re-admitting.
- `admitDirect` — admit a direct prompt as a queued submission; idempotent for an exact replay of the same submission id and payload.
- `markSubmissionCanonicalReady` — mark a queued submission's canonical conversation as materialized; idempotent while queued, `null` when missing or no longer queued.

Lifecycle methods:

- `claimSubmission` — atomic compare-and-set from queued to running, only when the submission is the runnable head of its session; records attempt, owner, lease, and start time. Two concurrent claims must never both succeed.
- `markSubmissionInputApplied` — install the durability budget (or defaults) once, at first input application, stamping `inputAppliedAt` as the once-guard; gated on a running submission owned by `attempt`. The stamp is bookkeeping — the canonical stream, not this timestamp, is the truth about whether input was persisted.
- `requestSessionAbort` — stamp `abortRequestedAt` (first request wins) on every unsettled submission in the session and return their ids. Never settles anything and never changes `status`; terminal settlement always happens through an attempt-based path.
- `requeueSubmission` — return a running submission to queued for a clean first attempt, clearing attempt, owner, lease, and durability stamp; gated only on ownership.
- `reserveSubmissionSettlement` — atomically reserve the exact canonical settlement record as an obligation (status becomes `terminalizing`); exact retries return the existing obligation, conflicting record identities or payloads return `null`.
- `finalizeSubmissionSettlement` — finalize an owned terminalizing submission after its canonical record exists; the row's error column mirrors the settlement outcome.
- `completeSubmission` / `failSubmission` — settle an owned running submission; a stale attempt or an already-settled submission returns `false` and the first terminal state is preserved. Settling a host atomically settles every `joined` submission attached to it with the same outcome, and reverts any unconfirmed `joining` stragglers to `queued`.

Turn-boundary join methods (dispatch-while-busy):

- `claimJoinableSubmissions` — atomically claim the contiguous prefix of the session's queued submissions for absorption into the host's live response (`queued → joining`, `joinedInto` set); gated on the host still running under its attempt, so a replaced attempt claims nothing.
- `finalizeJoinedSubmission` — confirm a claimed join once the delivery's canonical input record is durable (`joining → joined`).
- `revertJoiningSubmission` — hand a claimed-but-unconfirmed join back to the queue (`joining → queued`); legal only while the delivery's canonical input record does not exist.
- `listJoinedSubmissions` — every unsettled join attached to the host, in admission order.

Lease methods:

- `renewLeases` — extend the lease expiry (now + `LEASE_DURATION_MS`) for each listed submission that is running and owned by `ownerId`; others are silently skipped.
- `listExpiredSubmissions` — running submissions whose lease has expired; queued and settled submissions are never returned.

Exported constants: `DURABILITY_DEFAULT_MAX_ATTEMPTS` (`10`), `DURABILITY_DEFAULT_TIMEOUT_MS` (`3_600_000`), `LEASE_DURATION_MS` (`30_000`).

## `ConversationStreamStore`

Canonical per-agent-instance conversation streams: ordered, append-only batches of `ConversationRecord` values, written by a single fenced producer. The stream is the sole authoritative transcript — canonical state is reconstructed by replaying it from the beginning, and an adapter must not model a second transcript in session rows, snapshots, or event streams. Rejected operations throw `ConversationStreamStoreError` and leave the stream unchanged.

```ts
interface ConversationStreamStore {
  createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
  acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
  append(input: {
    path: string;
    producerId: string;
    producerEpoch: number;
    incarnation: string;
    producerSequence: number;
    submission?: { submissionId: string; attemptId: string };
    records: readonly ConversationRecord[];
  }): Promise<{ offset: string }>;
  read(
    path: string,
    options?: { offset?: string; limit?: number },
  ): Promise<ConversationStreamReadResult>;
  getMeta(path: string): Promise<ConversationStreamMeta | null>;
  subscribe(path: string, listener: () => void): () => void;
}
```

- `createStream` — create the stream if absent, minting a fresh incarnation id. Racing creates with the same identity both succeed; a conflicting identity for an existing path throws.
- `acquireProducer` — take exclusive producership: increments the producer epoch, resets the producer sequence, and returns a claim carrying the epoch, incarnation, and current head offset. Acquisition fences every prior producer.
- `append` — append one batch of records under one offset. Requires a current producer id, epoch, and incarnation, and the next expected `producerSequence`. An exact retry of an already-appended sequence returns the original offset; a conflicting retry throws. Records carrying `submissionId`/`attemptId` require a `submission` authorization that owns them. Every record in the batch persists together, all-or-nothing — a partial write corrupts the conversation graph.
- `read` — batches strictly after `options.offset` (default `'-1'`, the start). The sentinel `'now'` returns no batches and the current head as `nextOffset`. `limit` is clamped between `DEFAULT_READ_LIMIT` (`100`) and `MAX_READ_LIMIT` (`1000`). An offset beyond the head throws; an unknown path returns an empty, up-to-date result.
- `getMeta` — the stream's identity, incarnation, head offset, and producer state, or `null` for an unknown path.
- `subscribe` — register a process-local change listener for a path; returns an unsubscribe function. Notification is best-effort in-process fan-out, not a durable or cross-process signal.

Offsets are opaque strings ordered by the stream; `formatOffset` and `parseOffset` convert between offset strings and integer sequence numbers. `defineSqlConversationStreamStore(dialect: SqlConversationDialect)` builds a complete `ConversationStreamStore` over an async SQL backend — the Postgres, libSQL, and MySQL adapters share one fence implementation and differ only in dialect constants. `InMemoryConversationStreamStore` and `StreamListenerRegistry` are exported as reference building blocks.

## `AttachmentStore`

Immutable attachment bytes referenced by canonical conversation records via `AttachmentRef` — storage identity and integrity metadata (`id`, `mimeType`, `size`, `digest`, optional `filename`), not a download URL. `filename` is presentation metadata, excluded from identity comparisons.

```ts
interface AttachmentStore {
  put(input: PutAttachmentInput): Promise<void>;
  get(input: GetAttachmentInput): Promise<StoredAttachment | null>;
}
```

- `put` — store the bytes for an attachment id within a stream. Idempotent: an exact re-`put` (same ref, bytes, and conversation) succeeds, including concurrent exact puts. Reusing an id with different content, metadata, or ownership throws `AttachmentConflictError`. Bytes are verified against the ref's `size` and `digest`; a mismatch throws `AttachmentIntegrityError`.
- `get` — the stored attachment and bytes, or `null` when the id is unknown or the `conversationId` does not match. Integrity is verified on read.

Helpers: `createAttachmentRef` builds a ref (computing the SHA-256 `digest`), `verifyAttachmentBytes` checks bytes against a ref, `sameAttachmentRef` compares refs ignoring `filename`, `attachmentBytesEqual` and `copyAttachmentBytes` operate on byte arrays, and `InMemoryAttachmentStore` is a complete reference implementation.

## Cross-cutting requirements

Rules that hold across all three stores; the contract suites test each of them.

- **Idempotent admission.** An exact replay of an admission, append, put, or settlement reservation returns the original result; the same identity with different content is a conflict, never a silent overwrite.
- **Fenced producer claims.** Each conversation stream has at most one live producer. `acquireProducer` invalidates all prior claims; appends carrying a stale epoch or incarnation are rejected. Submission-owned appends additionally require the writing attempt to durably own the submission.
- **Append-only streams.** Canonical records are never updated or rewritten. A batch is all-or-nothing under a single offset, and offsets are strictly ordered.
- **First terminal state wins.** A settled submission's outcome is never overridden — stale attempts observe `false` from the settle methods.
- **Observable atomicity.** Where a method is described as atomic, concurrent callers must never both observe success; whether that is achieved with transactions, conditional updates, or unique indexes is the adapter's choice.
- **Schema-version stamping.** An adapter durably records its schema/format version when it first creates the store (current version: `FLUE_SCHEMA_VERSION`, `8`) and throws `PersistedSchemaVersionError` — before reading or writing any data — when opened against a store recorded with an unknown or newer version. `assertSupportedFlueSchemaVersion(storedVersion)` performs the check. The pre-1.0 format is reset-only: stores created by another version are cleared, never migrated in place. The built-in SQL adapters implement the stamp with a one-row `flue_meta` key/value table (key `'schema_version'`); non-SQL adapters implement the same obligation natively.

## Contract test suites

Three vitest suites in `@flue/runtime/test-utils` are the acceptance bar: an adapter is correct when all three pass against its stores. Each function registers a `describe` block; each test receives a fresh store from `backend.create()`, and `backend.cleanup?()` runs after each test.

```ts
import {
  defineAttachmentStoreContractTests,
  defineConversationStreamStoreContractTests,
  defineStoreContractTests,
} from '@flue/runtime/test-utils';

defineStoreContractTests('My backend', {
  async create() {
    return mySubmissionStore;
  },
  async cleanup() {
    /* close connections, delete temp state */
  },
});
```

- `defineStoreContractTests(label, backend)` — the `AgentSubmissionStore` suite: admission, canonical readiness, queue ordering, claims, lifecycle transitions, aborts, settlement obligations, durability stamping, attempt replacement, leases, and turn-boundary joins. `backend.create()` returns an `AgentSubmissionStore`.
- `defineConversationStreamStoreContractTests(label, backend)` — the `ConversationStreamStore` suite: racing creates, ordered atomic batches, idempotent and conflicting retries, producer fencing, submission-owned append authorization, and reads. `backend.create()` returns `{ stream, submissionStore? }`; the submission store is required for the authorization tests. Also importable from `@flue/runtime/test-utils/conversation-stream`.
- `defineAttachmentStoreContractTests(label, backend)` — the `AttachmentStore` suite: byte round-trips, idempotent and concurrent exact puts, conflict errors on identity reuse, and integrity errors. `backend.create()` returns an `AttachmentStore`. Also importable from `@flue/runtime/test-utils/attachment-store`.

## Adapter helpers

Pure helper functions exported from `@flue/runtime/adapter`, used by the built-in adapters and available to custom ones:

- `admitSubmissionWithBackend(input, backend)` — the shared admission algorithm for row-oriented backends (receipt check, attachment preparation, insert-or-ignore, read-back, idempotent-replay-vs-conflict comparison, chunk adoption). The caller owns transaction scoping; when every `SubmissionAdmissionBackend` callback is synchronous the result is returned synchronously, fitting synchronous transaction wrappers.
- `isSubmissionPayload(input, ctx)` — validate a parsed JSON payload against the stored submission metadata (`SubmissionPayloadContext`).
- `parseAcceptedAt(value, label)` — parse an ISO timestamp to epoch milliseconds; throws on an invalid value.
- `clampLimit(limit, defaultLimit, maxLimit)` — fall back to the default for invalid or non-positive limits, cap at the maximum.
- `createSessionStorageKey(agentName, instanceId, harness, session)` / `parseSessionStorageKey(key)` — serialize and parse the session-lane identity that fences queue ordering, abort, and attempt ownership. External submissions always use `SUBMISSION_HARNESS_NAME` and `SUBMISSION_SESSION_NAME` (both `'default'`).
- `createDispatchAgentSubmissionInput(input)` — convert a `DispatchInput` into the persisted `AgentSubmissionInput` shape.
- `prepareSubmissionAttachments`, `hydratePersistedSubmissionAttachments`, `matchesPersistedSubmissionAttachments`, `sameSubmissionChunks` — attachment chunking for oversized-row-safe payload storage, keyed by submission id (`SubmissionChunkRow`, `SubmissionChunkStore`).

The adapter surface is deliberately narrow: store interfaces, vocabulary types, and pure helpers — no runtime orchestration, provider plumbing, or generated-entry internals. The error classes (`ConversationStreamStoreError`, `AttachmentConflictError`, `AttachmentIntegrityError`, `PersistedSchemaVersionError`) are documented in [Errors](/docs/reference/errors/).
