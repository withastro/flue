---
title: Data Persistence API
description: Store Flue session conversation state through the public persistence contract.
---

The data persistence API controls **session conversation state** and **durable submission lifecycle**: recorded messages, task relationships, compaction summaries, provider affinity, submission admission/ordering, and workflow run history. It does not store sandbox files.

For deciding what must survive deployment, see [Agents](/docs/guide/building-agents/) and [Sandboxes](/docs/guide/sandboxes/). For build output and the deployment handoff, see [Develop & Build](/docs/guide/develop-and-build/).

## Imports

```ts
import { createAgent, type SessionData, type SessionStore } from '@flue/runtime';
```

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
| `load(id)`       | Return previously saved session data, or `null` when no stored session exists.   |
| `delete(id)`     | Delete the stored session state for that key.                                    |

Choose a store with consistency, retention, access control, and tenant-isolation properties appropriate to the conversation content your application retains.

## Configure persistence

Create a `src/db.ts` (or `.flue/db.ts`) file that default-exports a `PersistenceAdapter`:

```ts title="src/db.ts"
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

The `PersistenceAdapter` provides a `connect()` method that returns an `AgentExecutionStore` with both a `SessionStore` (for conversation snapshots) and an `AgentSubmissionStore` (for durable submissions). The build discovers `db.ts` automatically and wires it into the generated server entry.

For Cloudflare targets, the Durable Object SQLite store is the default and no `db.ts` is needed. Community adapters like `@flue/postgres` implement `PersistenceAdapter` for external databases.

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

Flue rejects records written with an unsupported `version`. During the beta,
clear older persisted session state when upgrading across a storage-version
change.

`affinityKey` is an opaque Flue-generated `aff_<ULID>` identity forwarded to
model providers for prompt caching and routing affinity. Persist it unchanged
when saving and reopening a session. It is separate from the supplied store
`id`, which remains Flue's lossless storage key.

`entries` contains the stored session history tree:

| Entry kind       | Contains                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| `message`        | Recorded user, assistant, and tool-shaped messages, including dispatch metadata where applicable. |
| `compaction`     | Summaries and token accounting used to shorten active model context.                              |
| `branch_summary` | Summary records for retained branch information.                                                  |

Treat `SessionData` as potentially sensitive. It can include model-visible text, tool output, dispatch input snapshots, and summaries derived from earlier content.

## Target defaults

| Runtime path                                                                              | Default conversation-state behavior                                                                         |
| ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Generated Node.js application with no `db.ts`                                            | Uses process-memory storage; state is lost on restart and is not shared between replicas.                   |
| Generated Node.js application with `db.ts`                                               | Uses the adapter's `SessionStore` and `AgentSubmissionStore` for durable sessions and submissions.          |
| Generated Cloudflare Durable Object-backed agent/workflow path                           | Uses Durable Object SQLite-backed session storage by default when the durable storage context is available. |

## Separate persistence responsibilities

| State category                                                 | Controlled by                                          |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| Agent session messages and compaction state                    | `SessionStore` via `db.ts` adapter or the target default |
| Agent submission admission, ordering, and terminal inspection rows | `AgentSubmissionStore` via `db.ts` adapter on Node; the owning Durable Object SQLite store on Cloudflare |
| Sandbox files, installed dependencies, and workspace artifacts | The configured sandbox or connector                    |
| Workflow run records and persisted run events                  | `RunStore` and `RunRegistry` via `db.ts` adapter. The Postgres adapter persists these durably; the built-in SQLite adapter uses in-memory storage (lost on restart). |
| Mutations performed through tools or external APIs             | The external system and application idempotency policy |

A persisted conversation does not make sandbox files durable. A durable workspace does not retain conversation history unless session persistence does as well. On Cloudflare, the Durable Object SQLite store provides both session snapshots and operational submission rows. On Node, the `db.ts` adapter provides both. A custom `PersistenceAdapter` via `db.ts` replaces canonical session snapshots and operational submission rows together. Those rows can contain submitted payloads while queued and running. Settled submission data is retained indefinitely in this beta release. Dispatch receipt rows also persist indefinitely, providing duplicate-delivery protection for repeated forwarding of one `dispatchId`; there is no public submission lookup API.

## Identity and deletion

Session data is stored under keys derived from Flue identity boundaries: agent instance or workflow invocation ownership, harness name, and session name. The stored record contains a separate opaque provider-affinity key. Delegated `task(...)` calls use internal child sessions whose retained history remains parent-owned; names beginning with `task:` are reserved for those children and cannot be selected as ordinary sessions. Deleting a parent session removes its stored conversation data and retained child task-session tree; application-owned stores may apply broader retention separately. When backed by a durable submission store, deletion rejects while the session still has queued or running durable submissions and removes settled operational payload copies after snapshot deletion succeeds. Deletion does not undo external effects or remove sandbox files.

## Implementing a custom adapter

A custom adapter implements `PersistenceAdapter` and is default-exported from `db.ts`. The adapter provides four stores: `SessionStore` and `AgentSubmissionStore` (via `connect()`), plus `RunStore` and `RunRegistry` (via `connectRunStore()` and `connectRunRegistry()`). Import store interfaces and helper types from `@flue/runtime/adapter`.

The built-in adapters (`sqlite()` and `@flue/postgres`) cover common backends. Build a custom adapter when you need a different database or hosting strategy. Use the shared contract test suite from `@flue/runtime/test-utils` to validate your implementation against the same behavioral assertions used by the built-in adapters.

```ts
import type { PersistenceAdapter } from '@flue/runtime/adapter';

const adapter: PersistenceAdapter = {
  async migrate() {
    // Run idempotent DDL (CREATE TABLE IF NOT EXISTS, etc.)
  },
  connect() {
    // Return { sessions: SessionStore, submissions: AgentSubmissionStore }
    return myExecutionStore;
  },
  connectRunStore() {
    return myRunStore;
  },
  connectRunRegistry() {
    return myRunRegistry;
  },
  async close() {
    // Clean up connections
  },
};
export default adapter;
```

Keep database credentials in trusted runtime configuration, enforce access control around routes that reopen sessions, and verify restart behavior in the deployment environment where continuity matters.
