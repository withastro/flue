---
title: Data Persistence API
description: Store Flue session conversation state through the public persistence contract.
---

The data persistence API controls **session conversation state**: recorded messages, task relationships, compaction summaries, provider affinity, and metadata needed to reopen a session. It does not store sandbox files or create workflow run history.

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

## Configure `persist`

Return a `SessionStore` in created-agent runtime configuration:

```ts title=".flue/agents/support.ts"
import { createAgent, type SessionStore } from '@flue/runtime';
import { sessionStore } from '../storage/session-store.ts';

const persist: SessionStore = sessionStore;

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  persist,
}));
```

`persist` applies to sessions initialized from that created agent. It is not an `init(...)` option because it determines the agent environment's conversation-state boundary.

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
| Generated Node.js application with no `persist` override                                  | Uses process-memory storage; state is lost on restart and is not shared between replicas.                   |
| Generated Cloudflare Durable Object-backed agent/workflow path with no `persist` override | Uses Durable Object SQLite-backed session storage by default when the durable storage context is available. |
| Created agent returning `persist`                                                         | Uses the supplied `SessionStore` instead of the target default for its sessions.                            |

## Separate persistence responsibilities

| State category                                                 | Controlled by                                          |
| -------------------------------------------------------------- | ------------------------------------------------------ |
| Agent session messages and compaction state                    | `SessionStore` / `persist` or the target default       |
| Cloudflare agent submission admission, ordering, and terminal inspection rows | The owning agent Durable Object SQLite store           |
| Sandbox files, installed dependencies, and workspace artifacts | The configured sandbox or connector                    |
| Workflow run records and persisted run events                  | Workflow-run runtime storage, not `SessionStore` alone |
| Mutations performed through tools or external APIs             | The external system and application idempotency policy |

A persisted conversation does not make sandbox files durable. A durable workspace does not retain conversation history unless session persistence does as well. On Cloudflare, a created agent's `persist` override replaces canonical session snapshots only: Flue still stores operational submission rows locally in the owning Durable Object SQLite database. Those rows can contain submitted payloads while queued and running. Terminal rows become eligible for bounded lazy cleanup after seven days and are removed during later agent activity; an entirely idle Durable Object may retain eligible rows longer. The same eligibility horizon bounds duplicate-delivery protection for repeated forwarding of one `dispatchId`; it does not create a public submission lookup API.

## Identity and deletion

Session data is stored under keys derived from Flue identity boundaries: agent instance or workflow invocation ownership, harness name, and session name. The stored record contains a separate opaque provider-affinity key. Delegated `task(...)` calls use internal child sessions whose retained history remains parent-owned; names beginning with `task:` are reserved for those children and cannot be selected as ordinary sessions. Deleting a parent session removes its stored conversation data and retained child task-session tree; application-owned stores may apply broader retention separately. On Cloudflare, deletion rejects while the session still has queued or running durable submissions and removes settled operational payload copies after snapshot deletion succeeds. Deletion does not undo external effects or remove sandbox files.

## Implementing a store

A custom store can use any application-controlled durable backend, such as Postgres, SQLite, Redis, or another database. Implement complete record replacement or suitable atomic behavior for your backend, since Flue calls `save(...)` with the current `SessionData` representation.

```ts
import type { SessionData, SessionStore } from '@flue/runtime';

export const sessionStore: SessionStore = {
  async save(id: string, data: SessionData) {
    await database.sessions.upsert(id, data);
  },
  async load(id: string) {
    return await database.sessions.get(id);
  },
  async delete(id: string) {
    await database.sessions.delete(id);
  },
};
```

Keep database credentials in trusted runtime configuration, enforce access control around routes that reopen sessions, and verify restart behavior in the deployment environment where continuity matters.
