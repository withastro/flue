---
title: Data Persistence API
description: Reference for Flue persistence adapters, stores, and session data.
---

Adapter authors implement these contracts to back a custom database. Import them from `@flue/runtime/adapter`:

```ts
import type {
  AgentExecutionStore,
  AgentSubmissionStore,
  EventStreamMeta,
  EventStreamReadResult,
  EventStreamStore,
  PersistenceAdapter,
  PersistenceStores,
  RunStore,
  SessionData,
  SessionStore,
} from '@flue/runtime/adapter';
import { formatOffset, parseOffset } from '@flue/runtime/adapter';
```

Application code usually configures an adapter through `db.ts` rather than implementing one; see [Database](/docs/guide/database/) for setup and target behavior. Most applications use the built-in `sqlite()` adapter or `@flue/postgres`.

There is one adapter contract for every backend — no SQL-only or "expert" tiers. Every method's invariants are written in terms of observable behavior, not storage primitives, so a non-SQL backend such as MongoDB is a first-class implementation: where a method is described as atomic, concurrent callers must never both observe success, and whether that is achieved with transactions, conditional updates, or unique indexes is the adapter's choice. An adapter is correct when the [contract suites pass](#validating-your-adapter).

Always typecheck a custom adapter against the real types from `@flue/runtime/adapter`. The signatures below reference vocabulary types — such as `AgentSubmission`, `AgentTurnJournal`, `RunRecord`, and `RunPointer` — exported from the same subpath. If this page drifts from the package, the package wins.

**Stability:** `SessionStore`, `RunStore`, and `EventStreamStore` are stable. The `AgentSubmissionStore` turn-journal, stream-chunk, and lease method groups (and the `AgentTurnJournalPhase` union) mirror the durable-execution engine and are subject to change until 1.0. This applies to every backend equally.

## `PersistenceAdapter`

```ts
interface PersistenceAdapter {
  connect(): PersistenceStores | Promise<PersistenceStores>;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}

interface PersistenceStores {
  readonly executionStore: AgentExecutionStore;
  readonly runStore: RunStore;
  readonly eventStreamStore: EventStreamStore;
}
```

A persistence adapter provides the database-backed stores used by a generated Node server. Flue calls `migrate()` once at startup when present, then awaits `connect()` once to obtain every store — an unreachable or misconfigured database fails at boot, not inside the first request. On shutdown, Flue calls `close()` when present. Adapters that create schema implicitly may omit `migrate()`, but must still uphold the schema-versioning obligation below in their store-creating paths.

| Method       | Contract                                                                                                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `connect()`  | Open the database and return all three stores. May return a `Promise`; async pool setup, remote handshakes, and — for adapters without `migrate()` — the schema-version check belong here. |
| `migrate?()` | Bring the store to the current schema/format version before connecting.                                                                                                                    |
| `close?()`   | Release connections, pools, or file handles during shutdown.                                                                                                                               |

### Schema versioning

Every adapter must durably record its schema/format version when it first creates the store, and fail loudly — before reading or writing any data — when opened against a store recorded with an unknown or newer version (for example, a database last touched by a newer Flue version after a rollback). The built-in SQL adapters record the version in a one-row `flue_meta` key/value table (key `'schema_version'`); non-SQL adapters implement the same obligation natively (a key, a meta document, etc.).

`@flue/runtime/adapter` exports the pieces an adapter needs:

- `FLUE_SCHEMA_VERSION` — the current schema/format version to record at store creation.
- `assertSupportedFlueSchemaVersion(storedVersion)` — throws unless the recorded version matches the current one.
- `PersistedSchemaVersionError` — the error thrown on a version mismatch.

## `AgentExecutionStore`

```ts
interface AgentExecutionStore {
  readonly sessions: SessionStore;
  readonly submissions: AgentSubmissionStore;
}
```

The execution store groups agent conversation storage and submission lifecycle storage.

## `SessionStore`

```ts
interface SessionStore {
  save(id: string, data: SessionData): Promise<void>;
  load(id: string): Promise<SessionData | null>;
  delete(id: string): Promise<void>;
}
```

| Method           | Contract                                                                         |
| ---------------- | -------------------------------------------------------------------------------- |
| `save(id, data)` | Persist the complete current session record under the supplied Flue storage key. |
| `load(id)`       | Return the saved session record, or `null` when none exists.                     |
| `delete(id)`     | Delete the stored session record for that key.                                   |

## `AgentSubmissionStore`

```ts
interface AgentSubmissionStore {
  getSubmission(submissionId: string): Promise<AgentSubmission | null>;
  getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null>;
  hasUnsettledSubmissions(): Promise<boolean>;
  listRunnableSubmissions(): Promise<AgentSubmission[]>;
  listRunningSubmissions(): Promise<AgentSubmission[]>;
  beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean>;
  updateTurnJournalPhase(
    attempt: SubmissionAttemptRef,
    phase: AgentTurnJournalPhase,
    options?: {
      checkpointLeafId?: string;
      toolRequest?: unknown;
      streamKey?: string;
    },
  ): Promise<boolean>;
  commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): Promise<boolean>;
  markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean>;
  replaceTurnJournalAttempt(
    attempt: SubmissionAttemptRef,
    nextAttemptId: string,
    lease?: { ownerId: string; leaseExpiresAt: number },
  ): Promise<AgentSubmission | null>;
  appendStreamChunkSegment(streamKey: string, segmentIndex: number, body: string): Promise<boolean>;
  getStreamChunkSegments(streamKey: string): Promise<Array<{ segmentIndex: number; body: string }>>;
  deleteStreamChunkSegments(streamKey: string): Promise<void>;
  admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission>;
  admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission>;
  claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null>;
  markSubmissionInputApplied(
    attempt: SubmissionAttemptRef,
    durability?: SubmissionDurability,
  ): Promise<boolean>;
  requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean>;
  requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean>;
  completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean>;
  failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean>;
  insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
  deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void>;
  listAttemptMarkers(): Promise<AgentAttemptMarker[]>;
  renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
  listExpiredSubmissions(): Promise<AgentSubmission[]>;
  deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
  listPendingSessionDeletions(): Promise<string[]>;
}
```

The submission store owns ordered admission, claim ownership, turn journals, stream chunks, recovery, attempt markers, lease renewal, and deletion coordination for direct prompts and `dispatch(...)` input.

The turn-journal, stream-chunk, and lease method groups are subject to change until 1.0 (see the stability note above). The invariants, by method group:

### Admission

`admitDispatch()` is idempotent admission keyed by dispatch id: an exact replay (same id, same payload) returns the already-admitted submission; the same id with a different payload returns `{ kind: 'conflict' }`; an id whose settled row was removed by session deletion returns its retained receipt. `admitDirect()` admits a direct prompt as a queued submission with the same exact-replay idempotency. Both throw while the target session is being deleted.

### Claim and lifecycle transitions

`claimSubmission()` is an atomic compare-and-set: it transitions the submission from queued to running only when it is currently queued and is the runnable head of its session — no earlier unsettled submission exists in the same session — recording the attempt id, owner, lease expiry, and start time, incrementing `attemptCount`, resetting `maxRetry` to the system default, and initializing `timeoutAt` when still unset (a previously initialized timeout is preserved across requeue/reclaim). It returns `null` when any condition fails, and two concurrent claims for the same submission must never both succeed. `listRunnableSubmissions()` returns exactly the submissions a claim would accept: at most one queued head per session, in admission order.

The remaining transitions are gated on a running submission owned by the calling attempt and return `false` otherwise: `markSubmissionInputApplied()` records once that input was canonically applied (installing the supplied durability, or defaults, on first application); `requestSubmissionRecovery()` stamps `recoveryRequestedAt` once; `requeueSubmissionBeforeInputApplied()` returns the submission to queued — clearing attempt, owner, and lease — only while input has not been applied; `completeSubmission()` and `failSubmission()` settle the submission, and the first terminal state wins — a stale attempt or an already-settled submission returns `false` and changes nothing.

### Turn journal

Each submission has at most one journal slot. `beginTurnJournal()` creates it or replaces an existing journal in place, resetting stream and commit state and increasing the revision. `updateTurnJournalPhase()` advances the phase of the uncommitted journal owned by the calling attempt, merging any provided options (absent options keep their stored values). `commitTurnJournal()` transitions only an uncommitted journal owned by the calling attempt — a second commit returns `false` and leaves the stored commit untouched. `markStreamConsumed()` stamps the consumption timestamp at most once, and only when the uncommitted journal stores the same stream key. `replaceTurnJournalAttempt()` is the recovery handoff: it atomically moves a running submission and its uncommitted journal to the new attempt id, increments `attemptCount`, clears any pending recovery request, and installs the new lease when given — or returns `null` without writing.

### Stream chunks

`appendStreamChunkSegment()` inserts a segment keyed by (`streamKey`, `segmentIndex`); when that key already exists it returns `false` **without overwriting** the stored body. `getStreamChunkSegments()` returns all segments ordered by `segmentIndex` ascending. `deleteStreamChunkSegments()` removes every segment for the stream.

### Attempt markers

Attempt markers are durable evidence that an attempt was started and has not yet settled; coordinators insert one before starting an attempt and delete it at settlement, and reconciliation treats a fresh marker as proof that the attempt may still be running. `insertAttemptMarker()` is idempotent — re-inserting the same (submission, attempt) pair keeps the original `createdAt`. `deleteAttemptMarker()` deletes only the exact match.

### Leases

`renewLeases()` extends the lease expiry (now + `LEASE_DURATION_MS`) for each listed submission that is running **and** owned by the given `ownerId`; submissions owned by another coordinator, settled, or unknown are silently skipped. `listExpiredSubmissions()` returns running submissions whose lease has expired (a positive `leaseExpiresAt` in the past); queued and settled submissions are never returned.

### Session deletion

`deleteSession()` deletes all settled submission state for a session in three phases: it rejects while any submission in the session is queued or running, else durably writes a deletion marker that blocks new admissions; it invokes `deleteSessionTree` (the runtime's snapshot deletion), removing the marker and rethrowing when that fails; and it finally retains a receipt for each settled dispatch admitted before the marker, removes those submissions and their journals and chunks, then removes the marker. Concurrent calls for the same session key share one in-flight deletion. `listPendingSessionDeletions()` returns the session keys whose marker survived a crash mid-deletion; coordinators resume these at startup by calling `deleteSession()` again.

## `RunStore`

```ts
interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  endRun(input: EndRunInput): Promise<void>;
  getRun(runId: string): Promise<RunRecord | null>;
  lookupRun(runId: string): Promise<RunPointer | null>;
  listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
}
```

The run store persists workflow-run records and serves run lookup and listing for `/runs`, `flue logs`, and the [inspection primitives](#inspection-primitives). Event payloads live in `EventStreamStore`. Agent prompts and dispatched agent input do not create workflow runs.

| Method        | Contract                                                                                                                                                                                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createRun()` | Persist a new `active` run record. Idempotent, first-writer-wins: when a record with the same `runId` already exists, the call is a no-op and the existing record — including any terminal status, result, or error — is preserved (`INSERT OR IGNORE` / `ON CONFLICT DO NOTHING`). |
| `endRun()`    | Finalize a run record with its terminal status, result, or error. A no-op when no record exists for `runId`.                                                                                                                                                                        |
| `getRun()`    | Return the full run record, or `null` when unknown.                                                                                                                                                                                                                                 |
| `lookupRun()` | Return the `RunPointer` projection of `getRun()` — every record field except `input`, `result`, and `error` — or `null` when unknown.                                                                                                                                               |
| `listRuns()`  | List run pointers newest first (`startedAt` descending, then `runId` descending), filtered by `status`/`workflowName` and paginated via the opaque `nextCursor`.                                                                                                                    |

Single-database adapters back all five methods from one run-records table; pointers are a column-subset select. Verify a custom implementation with `defineRunStoreContractTests` from `@flue/runtime/test-utils`.

## Inspection primitives

```ts
import { getRun, listAgents, listRuns } from '@flue/runtime';

function listRuns(options?: ListRunsOpts): Promise<ListRunsResponse>;
function getRun(runId: string): Promise<RunRecord | null>;
function listAgents(): Promise<AgentManifestEntry[]>;
```

Server-side free functions for application code running inside a Flue-built server. Like `dispatch(...)`, they read the generated runtime: `listRuns()` and `getRun()` read the configured run store, and `listAgents()` returns the built agents (`{ name, description?, transports, defined }`) from the deployment manifest. The optional `description` comes from the agent module's static `description` export; see [Agents](/docs/guide/building-agents/#creating-a-new-agent). Use them to [compose your own admin endpoints](/docs/api/routing-api/#compose-your-own-admin-endpoints) behind application-owned authorization — Flue ships no inspection HTTP surface of its own.

## `EventStreamStore`

```ts
interface EventStreamStore {
  createStream(path: string): Promise<void>;
  appendEvent(path: string, event: unknown): Promise<string>;
  readEvents(
    path: string,
    opts?: { offset?: string; limit?: number },
  ): Promise<EventStreamReadResult>;
  closeStream(path: string): Promise<void>;
  getStreamMeta(path: string): Promise<EventStreamMeta | null>;
  subscribe(path: string, listener: () => void): () => void;
}
```

`EventStreamStore` owns append-only event streams for agent instances and workflow runs. A path is typically `agents/<name>/<id>` or `runs/<runId>`. `appendEvent()` returns the new Durable Streams offset. `readEvents()` reads events strictly after `offset`; `"-1"` starts at the beginning and `"now"` starts at the current tail. `subscribe()` registers an in-process listener for appends or closure on that store instance; it is not a cross-process notification contract.

Missing-stream behavior is deliberately asymmetric: `readEvents()` on a nonexistent stream returns an empty up-to-date result (`{ events: [], nextOffset: "-1", upToDate: true, closed: false }`) rather than throwing — crash recovery reads a stream that the crashed process may never have created — while `appendEvent()` must throw. `createStream()` is idempotent: calling it on an existing stream is a no-op that preserves its events and offsets.

Offset format: offsets are strings in the Durable Streams format `<readSeq>_<seq>` — two 16-digit zero-padded integers separated by an underscore, with the first component always `0` (Flue uses integer sequences, not segmented files) — plus the sentinel `"-1"`. Offsets must increase monotonically per stream and remain comparable across reconnects. Use the `formatOffset()` and `parseOffset()` helpers from `@flue/runtime/adapter` to produce and consume them rather than hand-rolling the encoding.

`nextOffset` on `EventStreamReadResult` and `EventStreamMeta` is a resume cursor: the offset of the last event delivered or appended (`"-1"` when there is none), to be passed back as `offset` on the next read — never the next sequence number to be assigned. The name follows the Durable Streams `Stream-Next-Offset` wire field, which under strictly-after reads is the last delivered offset.

## `SessionData`

```ts
interface SessionData {
  version: 6;
  affinityKey: string;
  entries: SessionEntry[];
  leafId: string | null;
  taskSessions: TaskSessionRef[];
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}

interface TaskSessionRef {
  session: string;
  taskId: string;
}
```

`SessionData` is the complete persisted conversation record for one session.

| Field          | Contract                                                                                                                                           |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`      | Storage format version. Flue rejects unsupported versions.                                                                                         |
| `affinityKey`  | Opaque Flue-generated provider-affinity key. Persist it unchanged.                                                                                 |
| `entries`      | Stored message and compaction history.                                                                                                             |
| `leafId`       | Current active leaf in the session history tree, or `null`.                                                                                        |
| `taskSessions` | Framework bookkeeping: child task sessions created by delegated tasks. The recursive deletion cascade follows these references. Persist unchanged. |
| `metadata`     | Application-owned session metadata. Flue never reads or writes keys here.                                                                          |
| `createdAt`    | ISO timestamp for session creation.                                                                                                                |
| `updatedAt`    | ISO timestamp for the last persisted update.                                                                                                       |

`SessionData` may contain model-visible text, tool output, dispatch snapshots, and summaries derived from earlier content. Treat it as potentially sensitive.

## Adapter helpers

`@flue/runtime/adapter` also exports helper types and functions for custom backends, including:

- `createSessionStorageKey(...)`
- `parseAcceptedAt(...)`
- `FLUE_SCHEMA_VERSION`
- `assertSupportedFlueSchemaVersion(...)`
- `isSubmissionPayload(...)`
- `SUBMISSION_HARNESS_NAME`
- `DEFAULT_LIST_LIMIT`
- `MAX_LIST_LIMIT`
- `encodeRunCursor(...)`
- `decodeRunCursor(...)`
- `formatOffset(...)`
- `parseOffset(...)`

Use these helpers when implementing a backend that needs to preserve Flue's storage-key, timestamp, payload-validation, cursor, or event-stream offset semantics.

## Validating your adapter

`@flue/runtime/test-utils` exports the executable contract suites that the built-in SQLite and Postgres adapters themselves run. They are the acceptance test for a custom backend: your adapter is correct when these pass.

```ts
import {
  defineEventStreamStoreContractTests,
  defineRunStoreContractTests,
  defineStoreContractTests,
} from '@flue/runtime/test-utils';

defineStoreContractTests('MyBackend AgentExecutionStore', {
  async create() {
    const adapter = myBackend();
    await adapter.migrate?.();
    const { executionStore } = await adapter.connect();
    return executionStore;
  },
  async cleanup() {
    // close connections, delete temp state
  },
});

defineRunStoreContractTests('MyBackend RunStore', {
  async create() {
    const adapter = myBackend();
    await adapter.migrate?.();
    const { runStore } = await adapter.connect();
    return runStore;
  },
});

defineEventStreamStoreContractTests('MyBackend EventStreamStore', {
  async create() {
    const adapter = myBackend();
    await adapter.migrate?.();
    const { eventStreamStore } = await adapter.connect();
    return eventStreamStore;
  },
});
```

The suites run under [Vitest](https://vitest.dev/). Each test calls `create()` for a fresh store, so back the factory with an isolated database (in-memory, a temp file, or a per-test schema). `defineStoreContractTests` exercises every `SessionStore` and `AgentSubmissionStore` invariant documented on this page — admission idempotency, claim atomicity, attempt gating, journal commit gating, lease semantics, and deletion coordination — with identical assertions regardless of the storage engine.
