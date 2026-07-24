---
title: Postgres
description: Give Flue agents durable, shared state with a Postgres database.
package:
  name: '@flue/postgres'
  href: https://www.npmjs.com/package/@flue/postgres
lastReviewedAt: 2026-07-21
---

## Quickstart

Add durable, shared Postgres persistence to an existing Flue project with the [Postgres](https://www.postgresql.org) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database postgres
```

## Overview

The Postgres blueprint installs `@flue/postgres` and reuses an existing Postgres driver, or adds `pg` and the matching `@types/pg` development dependency by default. It creates a source-root `db.ts` and updates existing environment documentation when the project has it. The default generated adapter uses a pool for ordinary queries and keeps each transaction on one checked-out connection:

```ts title="src/db.ts (abridged)"
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

Flue discovers the adapter at build time and wires it into the generated Node server. On startup, it creates or verifies the required `flue_*` tables. Canonical agent conversations, immutable attachments, and accepted submissions then survive process replacement. Replicas may share durable state, but each agent instance still requires one live Node owner; Postgres does not enable active-active same-instance execution. Application business data remains application-owned. The blueprint applies only to Node targets because Cloudflare deployments use Durable Object SQLite instead.

## Configure

| Variable       | Purpose                                                                                |
| -------------- | -------------------------------------------------------------------------------------- |
| `DATABASE_URL` | **Required** — Postgres connection string, e.g. `postgresql://user:pass@host:5432/db`. |

Your driver reads `DATABASE_URL` at runtime — it is not baked into the build.
For local development, `vite dev` loads the project `.env`, and
`flue run --env <file>` selects an alternate `.env`-format file. In production,
supply it from your platform's secret store.

The blueprint installs `@flue/postgres` with `pg` by default and writes a
source-root `db.ts` that wraps it. Flue discovers `db.ts` at build
time and wires it into the generated Node server. After running the command,
canonical agent conversations, immutable attachments, and accepted submissions persist to Postgres instead of in-memory state.

`@flue/postgres` is a **Node.js** adapter. The Cloudflare target uses Durable
Object SQLite automatically and rejects a `db.ts` file at build time, so this
guide applies to Node deployments. See [Database](/docs/guide/database/) for the
full picture of how state is stored on each target.

## Bring your own driver

`@flue/postgres` does not pick or bundle a database driver. It runs against a
small runner you wrap around your configured driver, so you own driver choice,
pooling, TLS, and every other connection option. A runner is three functions:
`query` (a SQL string with numbered `$N` placeholders plus positional params,
resolving to result rows), `transaction` (runs its callback inside one
transaction on a single connection), and `close`.

With [`pg`](https://node-postgres.com/) (node-postgres), `transaction` checks
out a single client and issues `BEGIN`/`COMMIT`/`ROLLBACK` itself — a pool
cannot run a transaction across arbitrary connections:

```ts title="src/db.ts"
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    // ...
  },
  close: () => pool.end(),
});
```

The same seam adapts drivers that support interactive transactions on one
connection. For Neon, use its WebSocket `Pool`; the HTTP query client cannot
implement this callback transaction contract.

## Migrations

The adapter's `migrate()` hook runs automatically when the generated Node
server starts. It creates Flue's `flue_*` tables idempotently and stamps a
schema version, so a fresh database is provisioned on first boot and an existing
one is reused on restart. There is no separate migration command to run, and a
database written by a newer Flue refuses to start rather than corrupting state.

## What gets stored

A Flue database stores runtime state, not your whole application.

Stored by Flue:

- canonical agent conversation streams and compaction records;
- immutable attachment payloads;
- accepted direct prompts and `dispatch(...)` submissions;
- durable submission claims, leases, and settlement records.

Not stored by Flue:

- sandbox files and installed dependencies;
- external API side effects;
- application-owned business data, unless your own tools store it;
- provider credentials or secrets.

The submission rows are what make accepted work
recoverable after an interruption. See [Durability](/docs/guide/durability/)
for how recovery uses them, and the [Data Persistence API](/docs/reference/data-persistence-api/)
for the exact adapter contract.

## When to choose Postgres

| Use case                                                       | Adapter                                                       |
| -------------------------------------------------------------- | ------------------------------------------------------------- |
| Local development, or restart persistence is unnecessary       | `sqlite()` from `@flue/runtime/node` (file path or in-memory) |
| Single-host Node deployment                                    | File-backed `sqlite()`                                        |
| Multi-replica Node deployment, or state must survive host loss | `@flue/postgres`, with one live owner per agent instance      |
| Cloudflare deployment                                          | Built-in Durable Object SQLite (no `db.ts`)                   |

Choose Postgres when a replacement process must recover accepted work, when replicas need shared conversation state, or when a single host's disk is not a durable enough home for state. Keep one live owner for each agent instance and use instance-affine routing across replicas. Managed Postgres pairs naturally with the container deploy targets —
see [Deploy on AWS](/docs/ecosystem/deploy/aws/) for RDS, and the other
[deploy guides](/docs/ecosystem/deploy/node/) for provisioning a database
alongside the server.
