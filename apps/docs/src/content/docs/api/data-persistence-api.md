---
title: Data Persistence API
description: Reference for Flue persistence adapters, stores, and session data.
---

Adapter authors implement these contracts to back a custom database. Import them from `@flue/runtime/adapter`:

```ts
import type {
  AgentExecutionStore,
  AgentSubmissionStore,
  PersistenceAdapter,
  RunRegistry,
  RunStore,
  SessionData,
  SessionStore,
} from '@flue/runtime/adapter';
```

Application code usually configures an adapter through `db.ts` rather than implementing one; see [Database](/docs/guide/database/) for setup and target behavior. Most applications use the built-in `sqlite()` adapter or `@flue/postgres`.

Always typecheck a custom adapter against the real types from `@flue/runtime/adapter`. The signatures below reference vocabulary types — such as `AgentSubmission`, `AgentTurnJournal`, `RunRecord`, and `RunPointer` — exported from the same subpath. If this page drifts from the package, the package wins.

## `PersistenceAdapter`

```ts
interface PersistenceAdapter {
  connect(): AgentExecutionStore;
  connectRunStore(): RunStore;
  connectRunRegistry(): RunRegistry;
  migrate?(): void | Promise<void>;
  close?(): void | Promise<void>;
}
```

A persistence adapter provides the database-backed stores used by a generated Node server. Flue calls `migrate()` once at startup when present, then calls `connect()`, `connectRunStore()`, and `connectRunRegistry()`. On shutdown, Flue calls `close()` when present.

| Method                 | Contract                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `connect()`            | Return agent session and submission storage.                 |
| `connectRunStore()`    | Return workflow-run records and event storage.               |
| `connectRunRegistry()` | Return workflow-run indexing and listing storage.            |
| `migrate?()`           | Run idempotent schema setup before connecting.               |
| `close?()`             | Release connections, pools, or file handles during shutdown. |

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
  renewLeases(ownerId: string, submissionIds: string[]): Promise<void>;
  listExpiredSubmissions(): Promise<AgentSubmission[]>;
  deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void>;
}
```

The submission store owns ordered admission, claim ownership, turn journals, stream chunks, recovery, lease renewal, and deletion coordination for direct prompts and `dispatch(...)` input.

## `RunStore`

```ts
interface RunStore {
  createRun(input: CreateRunInput): Promise<void>;
  endRun(input: EndRunInput): Promise<void>;
  appendEvent(runId: string, event: FlueEvent): Promise<void>;
  getEvents(runId: string, fromIndex?: number): Promise<FlueEvent[]>;
  getRun(runId: string): Promise<RunRecord | null>;
}
```

The run store persists workflow-run records and workflow events. Agent prompts and dispatched agent input do not create workflow runs.

## `RunRegistry`

```ts
interface RunRegistry {
  recordRunStart(input: RecordRunStartInput): Promise<void>;
  recordRunEnd(input: RecordRunEndInput): Promise<void>;
  lookupRun(runId: string): Promise<RunPointer | null>;
  listRuns(opts?: ListRunsOpts): Promise<ListRunsResponse>;
}
```

The run registry indexes workflow runs for `/runs`, `flue logs`, and administrative run listing.

## `SessionData`

```ts
interface SessionData {
  version: 5;
  affinityKey: string;
  entries: SessionEntry[];
  leafId: string | null;
  metadata: Record<string, any>;
  createdAt: string;
  updatedAt: string;
}
```

`SessionData` is the complete persisted conversation record for one session.

| Field         | Contract                                                           |
| ------------- | ------------------------------------------------------------------ |
| `version`     | Storage format version. Flue rejects unsupported versions.         |
| `affinityKey` | Opaque Flue-generated provider-affinity key. Persist it unchanged. |
| `entries`     | Stored message, compaction, and branch-summary history.            |
| `leafId`      | Current active leaf in the session history tree, or `null`.        |
| `metadata`    | Application-visible session metadata.                              |
| `createdAt`   | ISO timestamp for session creation.                                |
| `updatedAt`   | ISO timestamp for the last persisted update.                       |

`SessionData` may contain model-visible text, tool output, dispatch snapshots, and summaries derived from earlier content. Treat it as potentially sensitive.

## Adapter helpers

`@flue/runtime/adapter` also exports helper types and functions for custom backends, including:

- `createSessionStorageKey(...)`
- `parseAcceptedAt(...)`
- `isSubmissionPayload(...)`
- `SUBMISSION_HARNESS_NAME`
- `DEFAULT_LIST_LIMIT`
- `MAX_LIST_LIMIT`
- `encodeRunCursor(...)`
- `decodeRunCursor(...)`
- `serializedEventForPersistence(...)`
- `parsePersistedWorkflowEvent(...)`

Use these helpers when implementing a backend that needs to preserve Flue's storage-key, timestamp, payload-validation, cursor, or workflow-event semantics.
