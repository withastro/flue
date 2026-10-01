---
title: Database
description: Configure where Flue durably stores agent conversations, from the in-memory default to SQLite, Postgres, and beyond.
lastReviewedAt: 2026-07-21
---

Flue durably stores agent conversations in a database, configured with a single `db.ts` file. This guide covers what Flue stores, how the `db.ts` entry module works, the in-memory default and its limits, the built-in `sqlite()` adapter, and the adapters for Postgres, libSQL, and other backends.

The database is a **Node.js** concern. On the Cloudflare target, every agent conversation is a Durable Object with its own built-in SQLite storage. There is nothing to configure, and a `db.ts` file is rejected at build time. See [Cloudflare](/docs/guide/cloudflare-target/) for how storage works there.

## What Flue stores

A Flue database stores the runtime's own durable state. It does not store your application's business data. Three kinds of records live there:

- **Canonical conversations.** Each agent conversation is one append-only stream of records that covers user messages, assistant output, tool calls and results, compaction, and recovery facts. This stream is the single source of truth. Every later turn, every reconnecting client, and every crash recovery rebuilds its view of the conversation by reading it back.
- **Accepted submissions.** When a prompt or `dispatch(...)` input is accepted, Flue records it durably _before_ processing begins, along with claims and leases that track which process owns the work. These rows make accepted work recoverable after an interruption instead of silently lost.
- **Persisted state.** Every [`usePersistentState`](/docs/guide/agent-hooks/#persisted-state) write is recorded in the conversation's stream, which is how state survives restarts for the life of the conversation.

Attachment payloads (images and other binary inputs) are stored alongside the conversation as immutable records that the canonical stream references.

Flue does _not_ store sandbox files and installed dependencies (see [Sandboxes](/docs/guide/sandboxes/)), external API side effects, provider credentials, or your application's own data. A durable database does not make a sandbox durable, and a durable workspace does not preserve conversation history. They are separate concerns. When a tool writes to your application's database, Flue stores only the record that the tool was called and what it returned.

## The `db.ts` entry module

To choose a database, create a `db.ts` file in your project's [source directory](/docs/guide/project-layout/#source-directory) and default-export a persistence adapter:

```ts title="src/db.ts"
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

Like `app.ts`, the `db.ts` entry is discovered by convention. `vite dev`, `vite build`, and `flue run` all resolve it from the source root (`.flue/`, `src/`, or the project root) and connect it at startup. To place it somewhere else, set the `db` path in your config file. See [Configuration](/docs/reference/configuration/#db).

Because the module is ordinary TypeScript, the adapter can read connection strings from the environment, construct a driver pool, and export whatever the situation calls for. Flue calls the adapter's `migrate()` once at boot to create or verify its tables, then awaits `connect()`. An unreachable or misconfigured database therefore fails at startup, not in the middle of your first conversation.

Standalone scripts using [`start()`](/docs/guide/building-agents/#standalone-scripts) don't go through the build, so they don't pick up `db.ts`. Pass the adapter directly via the `db` option instead.

## The in-memory default

Without a `db.ts`, Flue runs on in-memory SQLite. Conversations, persisted state, and recovery within the process lifetime all work, but **a restart loses every conversation, accepted submission, and piece of state**. This is fine for development. In production, it is acceptable only for disposable agents.

The development commands soften this default:

| Command      | Without `db.ts`                                                                                                             |
| ------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `vite dev`   | A cache file (`node_modules/.cache/flue/dev.db`). History survives code reloads and resets when the dev server cold-starts. |
| `flue run`   | A cache file (`node_modules/.cache/flue/run.db`). It never resets, so `--id` continues conversations across invocations.    |
| `vite build` | In-memory. The deployed server keeps state only for the process lifetime.                                                   |

With a `db.ts`, all three use your adapter, so development runs against the same storage as production.

## The built-in `sqlite()` adapter

The `sqlite()` adapter ships with the runtime and needs no extra dependencies. It runs on Node's built-in `node:sqlite` module. Point it at a file path for storage that survives restarts:

```ts title="src/db.ts"
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

The adapter creates the file (and any missing parent directories) on first boot and opens it in WAL mode. Calling `sqlite()` with no argument, or with `':memory:'`, gives you the same in-memory database as the default.

A file-backed SQLite database covers a single-host deployment. It survives process restarts and redeploys on the same machine, but not the loss of the host itself. When state must survive host loss, or multiple replicas need to share it, use an external database.

## Ecosystem adapters

Flue publishes adapters for the major databases, each available as a [blueprint](/docs/cli/add/). A blueprint is a Markdown implementation guide that your coding agent applies. It is not a package installer. The blueprint name is the backend's lowercase name:

```sh
flue add database postgres
```

| Backend                                         | Adapter package  |
| ----------------------------------------------- | ---------------- |
| [Postgres](/docs/ecosystem/databases/postgres/) | `@flue/postgres` |
| [Supabase](/docs/ecosystem/databases/supabase/) | `@flue/postgres` |
| [libSQL](/docs/ecosystem/databases/libsql/)     | `@flue/libsql`   |
| [Turso](/docs/ecosystem/databases/turso/)       | `@flue/libsql`   |
| [MySQL](/docs/ecosystem/databases/mysql/)       | `@flue/mysql`    |
| [MongoDB](/docs/ecosystem/databases/mongodb/)   | `@flue/mongodb`  |
| [Redis](/docs/ecosystem/databases/redis/)       | `@flue/redis`    |
| [Valkey](/docs/ecosystem/databases/valkey/)     | `@flue/redis`    |

These adapters share a **bring-your-own-driver** design. The adapter implements Flue's storage contract, but it does not pick, bundle, or configure a database driver. Instead, you wrap your configured driver in a small runner (typically a `query` function, a `transaction` function, and a `close` function) and hand it to the adapter. You keep control of driver choice, pooling, TLS, and credentials, and Flue coexists with however your application already talks to its database:

```ts title="src/db.ts"
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (text, params) => (await client.query(text, params)).rows,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
```

Each blueprint generates a complete `db.ts` like this one for its backend's standard driver. Each backend page documents the runner interface and the backend's durability caveats.

There are no migrations to run by hand with any adapter. `migrate()` provisions Flue's tables idempotently on first boot, reuses them on restart, and stamps a format version. A database written by an incompatible Flue version refuses to start rather than corrupting state.

A shared database does **not** enable active-active scaling. A durable external database lets a replacement process recover accepted work and lets replicas share conversation state, but each agent conversation still needs exactly one live Node owner at a time. See [Durability](/docs/guide/durability/#nodejs-recovery) for the ownership rules and what recovery replays.

## Writing a custom adapter

If your backend isn't in the catalog, you can implement the storage contract yourself. An adapter is an object with `connect()`, which returns the three stores (submissions, conversation streams, and attachments), plus optional `migrate()` and `close()`. The types live in `@flue/runtime/adapter`:

```ts
import type { PersistenceAdapter } from '@flue/runtime/adapter';

export default {
  migrate() {
    /* create or verify backing storage */
  },
  connect() {
    return { submissionStore, conversationStreamStore, attachmentStore };
  },
  close() {
    /* release connections */
  },
} satisfies PersistenceAdapter;
```

The contract has strict atomicity and ordering requirements, such as idempotent admission, fenced producer claims, and append-only streams. Treat the [Data Persistence API](/docs/reference/data-persistence-api/) as the specification, and run the contract test suites from `@flue/runtime/test-utils` against your implementation. They are the acceptance tests every built-in adapter passes.

## Choosing a database

| Situation                                      | Choice                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------- |
| Local development                              | The defaults. Add `db.ts` only to develop against production storage |
| Single-host Node deployment                    | File-backed `sqlite()`                                               |
| State must survive host loss, or many replicas | An ecosystem adapter, with one live owner routed per conversation    |
| Cloudflare deployment                          | Nothing to configure. Durable Object SQLite is automatic             |
| A backend not in the catalog                   | A custom `PersistenceAdapter`                                        |

## Next steps

- [Durability](/docs/guide/durability/) — what recovery replays after an interruption, and the one-live-owner rule.
- [Data Persistence API](/docs/reference/data-persistence-api/) — the full adapter and store contracts.
- [Postgres](/docs/ecosystem/databases/postgres/) and the other database pages: per-backend setup, configuration, and caveats.
- [Deploy Agents on Node.js](/docs/ecosystem/deploy/node/) — provisioning a database alongside your server.
- [Project Layout](/docs/guide/project-layout/) — where `db.ts` and the other entry modules live.
