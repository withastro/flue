---
title: libSQL
description: Give Flue agents durable state with libSQL — a local SQLite file, a self-hosted libSQL server, or an embedded replica.
package:
  name: '@flue/libsql'
  href: https://www.npmjs.com/package/@flue/libsql
lastReviewedAt: 2026-07-21
---

## Quickstart

Add durable libSQL persistence to an existing Flue project with the [libSQL](https://github.com/tursodatabase/libsql) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database libsql
```

## Overview

The libSQL blueprint installs `@flue/libsql` and `@libsql/client`, creates a source-root `db.ts`, and updates existing environment documentation when the project has it. The generated adapter maps client result sets to plain objects and serializes operations so a local SQLite file does not receive overlapping writes from one process:

```ts title="src/db.ts (abridged)"
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({ url: process.env.LIBSQL_URL! });

export default libsql({
  query: (text, params = []) => {
    // await client.execute({ sql: text, args: params }))),
    // ...
  }
  transaction: (fn) => {
    // const tx = await client.transaction('write');
    // ...
  }
  close: () => client.close(),
});
```

Flue discovers the adapter at build time and wires it into the generated Node server. On startup, it creates or verifies the required `flue_*` tables. Canonical agent conversations, immutable attachments, and accepted submissions then persist in a local SQLite file or self-hosted libSQL server according to `LIBSQL_URL`; application business data remains application-owned. Embedded replicas require additional `syncUrl` client configuration. The blueprint applies only to Node targets because Cloudflare deployments use Durable Object SQLite instead.

## Configure

| Variable     | Purpose                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `LIBSQL_URL` | **Required** — A local file (`file:./data/flue.db`) or a libSQL server (`http://host:8080`). |

`createClient` reads this at runtime — it is not baked into the build. For local
development, `vite dev` loads the project `.env`, and `flue run --env <file>` loads any
`.env`-format file. In production, supply it from your platform's secret store.

The blueprint installs `@flue/libsql` and the official `@libsql/client`, and
writes a source-root `db.ts` that wraps the client. Flue discovers `db.ts` at
build time and wires it into the generated Node server. For hosted Turso, use
[`flue add database turso`](/docs/ecosystem/databases/turso/) instead — it is the same
adapter with a Turso client configuration.

`@flue/libsql` is a **Node.js** adapter. The Cloudflare target uses Durable
Object SQLite automatically and rejects a `db.ts` file at build time, so this
guide applies to Node deployments. See [Database](/docs/guide/database/) for the
full picture of how state is stored on each target.

## Bring your own driver

`@flue/libsql` does not pick or bundle a database driver. It runs against a
small runner you wrap around your configured
[`@libsql/client`](https://docs.turso.tech/sdk/ts/reference), so you own the
client and its connection options. A runner is three functions: `query` (a SQL
string with `?` placeholders plus positional params, resolving to result rows),
`transaction` (runs its callback inside one `write` transaction), and `close`.
`@libsql/client` returns a `ResultSet`, so map its `rows`/`columns` into plain
objects:

```ts title="src/db.ts"
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({ url: process.env.LIBSQL_URL! });

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

let tail: Promise<unknown> = Promise.resolve();
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = tail.then(operation, operation);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export default libsql({
  query: (text, params = []) =>
    serialize(async () => toRows(await client.execute({ sql: text, args: params }))),
  transaction: (fn) =>
    serialize(async () => {
      const tx = await client.transaction('write');
      try {
        const result = await fn({
          query: async (text, params = []) => toRows(await tx.execute({ sql: text, args: params })),
        });
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback();
        throw error;
      } finally {
        tx.close();
      }
    }),
  close: () => client.close(),
});
```

## Connection targets

`createClient` decides where state lives — the adapter is identical across all
of them:

| Target                                           | `createClient(...)`                                     |
| ------------------------------------------------ | ------------------------------------------------------- |
| Local SQLite file                                | `{ url: 'file:./data/flue.db' }`                        |
| Self-hosted libSQL server (`sqld`)               | `{ url: 'http://127.0.0.1:8080' }`                      |
| Embedded replica (local file synced to a remote) | `{ url: 'file:local.db', syncUrl, authToken }`          |
| Hosted Turso                                     | see the [Turso guide](/docs/ecosystem/databases/turso/) |

### Embedded-file concurrency

When `LIBSQL_URL` is a local `file:` database, asynchronous writes can overlap
and surface `SQLITE_BUSY`. The runner above serializes all operations from one
process so its transactions do not contend with top-level queries. Flue does
not promise multi-process or multi-tenant writes to one embedded file. A
self-hosted libSQL server and hosted Turso serialize writes server-side.

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

See [Durability](/docs/guide/durability/) for how recovery uses
submission state, and the [Data Persistence API](/docs/reference/data-persistence-api/)
for the exact adapter contract.

## When to choose libSQL

| Use case                                                    | Adapter                                                                    |
| ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| Local development                                           | `sqlite()` from `@flue/runtime/node`, or libSQL against a `file:` database |
| Single-host Node deployment                                 | File-backed `sqlite()` or libSQL `file:`                                   |
| Self-hosted SQLite over the network, or an embedded replica | `@flue/libsql`                                                             |
| Hosted, replicated SQLite                                   | `@flue/libsql` against [Turso](/docs/ecosystem/databases/turso/)           |
| Multi-replica Node deployment on Postgres                   | [`@flue/postgres`](/docs/ecosystem/databases/postgres/)                    |

libSQL is the right choice when you want SQLite's model but reachable over the
network or kept close to the app as an embedded replica. For a fully managed,
replicated deployment, point the same adapter at [Turso](/docs/ecosystem/databases/turso/).
