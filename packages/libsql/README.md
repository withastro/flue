# `@flue/libsql`

libSQL / Turso durable persistence for Flue applications on the Node.js target.
One package serves a local SQLite file, a self-hosted libSQL server (`sqld`),
an embedded replica, and hosted [Turso](https://turso.tech).

```ts
// src/db.ts
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({
  url: process.env.LIBSQL_URL!,
  authToken: process.env.LIBSQL_AUTH_TOKEN,
});

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

Default-export the adapter from a source-root `db.ts`. Flue discovers it at
build time and wires it into the generated Node server. The adapter's
`migrate()` hook runs once at startup and creates its tables idempotently, so
there is no separate migration step.

This adapter persists Flue's runtime state:

- agent session snapshots and compaction state;
- accepted direct prompts and `dispatch(...)` submissions, with the durable
  turn journals and leases that back interruption recovery;
- workflow-run records and persisted run events;
- run indexing for `/runs` lookups and `listRuns()`.

It does not store your application's business data. Keep customer records,
tickets, and payments in your own tables.

## Bring your own driver

`@flue/libsql` does **not** pick or bundle a database driver. It runs against a
small runner you wrap around your configured [`@libsql/client`](https://docs.turso.tech/sdk/ts/reference),
so you own the client and its connection options. A runner is three functions:

- `query(text, params)` — run a SQL string with `?` placeholders and positional
  parameters, resolving to the result rows as plain objects. `@libsql/client`
  returns a `ResultSet`; map its `rows`/`columns` into plain objects (the
  `toRows` helper above).
- `transaction(fn)` — run `fn` inside a single `write` transaction, committing
  on resolve and rolling back on throw. The `tx` passed to `fn` only needs
  `query`.
- `close()` — close the client.

## Connection targets

`createClient` decides where state lives — the adapter is identical across all
of them:

| Target                                        | `createClient(...)`                                          |
| --------------------------------------------- | ------------------------------------------------------------ |
| Hosted Turso                                  | `{ url: 'libsql://<db>.turso.io', authToken }`               |
| Embedded replica (local file synced to Turso) | `{ url: 'file:local.db', syncUrl: 'libsql://…', authToken }` |
| Self-hosted libSQL server (`sqld`)            | `{ url: 'http://127.0.0.1:8080' }`                           |
| Local SQLite file                             | `{ url: 'file:./data/flue.db' }`                             |

## Embedded-file concurrency

When `url` is a local `file:` database, the embedded driver can surface
`SQLITE_BUSY` when asynchronous writes overlap. The runner above serializes all
operations from one process so its transactions do not contend with top-level
queries. Flue does not promise multi-process or multi-tenant writes to one
embedded file. Hosted Turso and a libSQL server serialize writes server-side.

## Target support

This adapter targets **Node.js**. The Cloudflare target uses Durable Object
SQLite automatically and rejects a `db.ts` file at build time, so a database
adapter does not apply there.

## Installation

```sh
flue add database libsql   # local file / self-hosted libSQL server
flue add database turso    # hosted Turso
```

Both install this package and write the `db.ts` for the chosen target. See the
[libSQL guide](https://flueframework.com/docs/ecosystem/databases/libsql/) and
[Turso guide](https://flueframework.com/docs/ecosystem/databases/turso/) for
setup and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/)
for the adapter contract.
