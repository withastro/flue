---
title: Database
description: Configure database-backed state for Flue agents and workflow runs.
---

Flue uses a database for agent session history, accepted agent submissions, and workflow-run records. On Node.js, database setup is explicit through `db.ts`. On Cloudflare, generated Durable Objects use SQLite automatically.

This guide covers how `db.ts` works, which built-in adapters are available, and what database-backed state does and does not cover. For interruption recovery and restart behavior, see [Durable Execution](/docs/guide/durable-execution/). For the exact adapter contract, see [Data Persistence API](/docs/api/data-persistence-api/).

## `db.ts`

On Node.js, add a source-root `db.ts` file when state should survive process restart:

```ts title="src/db.ts"
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

Flue discovers `db.ts` at build time and wires the exported `PersistenceAdapter` into the generated server entry. The adapter provides:

- agent session snapshots;
- accepted direct prompts and `dispatch(...)` submissions;
- workflow-run records and events;
- workflow-run indexing for `/runs` and administrative listing.

Without `db.ts`, the Node target uses in-memory SQLite for agent sessions and submissions, plus in-memory workflow-run storage. That gives one running process ordered state handling, but all of that state disappears when the process exits.

Cloudflare does not use `db.ts`. Generated agent and workflow Durable Objects use SQLite automatically.

## SQLite on Node.js

`sqlite()` is the built-in Node adapter, exported from `@flue/runtime/node`. Pass a file path for state that survives process restart, or omit the path for an in-memory database:

```ts title="src/db.ts"
import { sqlite } from '@flue/runtime/node';

// File-backed: survives process restart on the same host.
export default sqlite('./data/flue.db');

// In-memory: equivalent to omitting db.ts; lost on exit.
// export default sqlite();
```

A file-backed SQLite database is a good fit for local development, a single-host deployment, or a small service where one machine owns the application state. It does not protect against host loss, and it does not make state available to another replica.

## Postgres on Node.js

Use `@flue/postgres` when state must survive host replacement or be shared across multiple application replicas:

```ts title="src/db.ts"
import { postgres } from '@flue/postgres';

export default postgres(process.env.DATABASE_URL!);
```

The Postgres adapter persists agent session snapshots, submission rows, workflow-run records, workflow events, and run indexing. Its `migrate()` hook runs automatically when the generated Node server starts.

A shared Postgres database is the right choice when another Node process must recover accepted work after a host failure or when several replicas need access to the same workflow-run history.

## Cloudflare SQLite

On Cloudflare, generated agent and workflow Durable Objects use SQLite automatically. Agent session history, accepted submissions, and workflow-run records are stored in Durable Object SQLite; run indexing is stored in Flue's generated `FlueRegistry` Durable Object. No `db.ts` file is needed, and Cloudflare builds reject one if present.

Cloudflare Durable Objects also provide the ownership boundary for agent execution: one agent instance owns its own ordered submission queue. See [Cloudflare Target](/docs/guide/targets/cloudflare/) for generated Durable Object behavior and [Deploy Agents on Cloudflare](/docs/ecosystem/deploy/cloudflare/) for Wrangler migrations.

## What the database stores

A Flue database stores runtime state, not your whole application.

| Stored by Flue                                          | Not stored by Flue                                             |
| ------------------------------------------------------- | -------------------------------------------------------------- |
| Agent session messages and compaction state             | Sandbox files and installed dependencies                       |
| Accepted direct prompts and `dispatch(...)` submissions | External API side effects                                      |
| Workflow-run records and persisted events               | Application-owned business data unless your own tools store it |
| Run indexing for `/runs` and admin listing              | Provider credentials or secrets                                |

A persisted session does not make a sandbox durable. A durable workspace does not preserve conversation history by itself. Keep customer records, payments, tickets, and other business data in your own application database or external system.

## Choosing an adapter

| Use case                      | Recommended adapter                                                                |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| Local development             | `sqlite()` with a file path, or no `db.ts` when restart persistence is unnecessary |
| Single-host Node deployment   | File-backed `sqlite()`                                                             |
| Multi-replica Node deployment | `@flue/postgres`                                                                   |
| Cloudflare deployment         | Built-in Durable Object SQLite                                                     |
| Another database backend      | Custom `PersistenceAdapter`                                                        |

A custom adapter can implement another database or hosting strategy through `@flue/runtime/adapter`. Use this when the built-in SQLite and Postgres adapters do not fit your deployment.
