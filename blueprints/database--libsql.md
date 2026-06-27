---
{ "kind": "database", "version": 1, "website": "https://github.com/tursodatabase/libsql" }
---

# Add a libSQL Database to Flue

You are an AI coding agent configuring libSQL-backed persistence for a Flue
project using the first-party `@flue/libsql` adapter. Use this for a local
SQLite file, a self-hosted libSQL server (`sqld`), or an embedded replica. For
hosted Turso, use the `turso` blueprint instead — it is the same package with a
different client configuration.

This persists canonical agent conversation streams, immutable attachments,
accepted submissions, workflow-run records, and event
streams. It does not store application business data.

## Check the target first

A `db.ts` adapter is a **Node-target** concern. The Cloudflare target uses
Durable Object SQLite automatically and rejects `db.ts` at build time. If this
project targets Cloudflare, stop and tell the user — there is nothing to add.

## Inspect the project

Read local instructions (`AGENTS.md` and similar), detect the package manager,
and select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Check for an existing `db.ts` — if one is present, the project
already has an adapter; confirm with the user before replacing it. Inspect how
the project reads secrets.

Install `@flue/libsql` and the official [`@libsql/client@^0.17.3`](https://docs.turso.tech/sdk/ts/reference)
with the project's package manager. `@flue/libsql` does not bundle a driver.

## Create `db.ts`

Write `<source-dir>/db.ts` with a default-exported adapter that wraps the
client in the runner shape — `query` (a SQL string with `?` placeholders plus
positional params, resolving to result rows), a `transaction` that runs its
callback in one `write` transaction, and `close`. `@libsql/client` returns a
`ResultSet`, so map its `rows`/`columns` into plain objects:

```ts title="src/db.ts"
// flue-blueprint: database/libsql@1
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

// Local file: `file:./data/flue.db`
// Self-hosted libSQL server (sqld): `http://127.0.0.1:8080`
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

Do not hardcode a connection string, and do not invent one — `LIBSQL_URL` (or
the project's existing equivalent) is supplied by the environment.

Flue discovers `db.ts` at build time and wires the default export into the
generated Node server. The adapter's `migrate()` hook runs automatically at
startup and creates its tables idempotently, so there is no separate migration
step. Do not add an `app.ts` solely to register the database.

When `LIBSQL_URL` points at a local `file:` database, asynchronous writes can
otherwise overlap and return `SQLITE_BUSY`. Keep the shared promise chain in the
runner so top-level queries and transactions from this process are serialized.
This does not provide multi-process or multi-tenant write coordination; use a
libSQL server or hosted Turso for that deployment shape.

## Credentials

The client reads its connection target (and any auth token) at runtime. Follow
the project's secret conventions and never commit real values. For local
development, `flue dev --env <file>` and `flue run --env <file>` load any
`.env`-format file. Update existing environment documentation or `.env.example`
when the project keeps one.

## Verify

1. Typecheck the project (`npx tsc --noEmit` is safe).
2. Build the project's configured Node target and confirm the adapter is
   discovered and wired into the generated server.
3. With `LIBSQL_URL` set (a local `file:` database is fine), start the server
   and confirm it boots — `migrate()` creates the `flue_*` tables on first run.
   Restart it and confirm existing state is reloaded rather than recreated.
4. Do not point the adapter at a production database to test.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
