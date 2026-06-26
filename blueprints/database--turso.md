---
{ "kind": "database", "version": 1, "website": "https://turso.tech" }
---

# Add a Turso Database to Flue

You are an AI coding agent configuring hosted [Turso](https://turso.tech)
persistence for a Flue project using the first-party `@flue/libsql` adapter.
Turso is hosted libSQL; this is the same adapter as the `libsql` blueprint with
a Turso client configuration. For a local file or self-hosted libSQL server,
use the `libsql` blueprint instead.

This persists canonical agent conversation streams, disposable snapshots,
immutable attachments, accepted submissions, workflow-run records, and event
streams across process restarts and replicas. It does not store application
business data.

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

The user creates the database and an auth token with the
[Turso CLI](https://docs.turso.tech/cli/introduction) (`turso db create`,
`turso db show --url`, `turso db tokens create`). Never invent these values.

## Create `db.ts`

Write `<source-dir>/db.ts` with a default-exported adapter that wraps the Turso
client in the runner shape — `query` (a SQL string with `?` placeholders plus
positional params, resolving to result rows), a `transaction` that runs its
callback in one `write` transaction, and `close`. `@libsql/client` returns a
`ResultSet`, so map its `rows`/`columns` into plain objects:

```ts title="src/db.ts"
// flue-blueprint: database/turso@1
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

export default libsql({
  query: async (text, params = []) => toRows(await client.execute({ sql: text, args: params })),
  transaction: async (fn) => {
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
  },
  close: () => client.close(),
});
```

Do not hardcode the URL or token, and do not invent them — `TURSO_DATABASE_URL`
(a `libsql://` URL) and `TURSO_AUTH_TOKEN` come from the environment. Turso
serializes writes server-side, so there is no embedded-file concurrency concern.

For lower read latency, the project can use a Turso **embedded replica** — a
local file synced from the remote database — by adding `syncUrl` and a local
`file:` `url`. Suggest this only if the user asks about read latency; the plain
remote client above is the default.

Flue discovers `db.ts` at build time and wires the default export into the
generated Node server. The adapter's `migrate()` hook runs automatically at
startup and creates its tables idempotently, so there is no separate migration
step. Do not add an `app.ts` solely to register the database.

## Credentials

The client reads `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` at runtime. Follow
the project's secret conventions and never commit real values. For local
development, `flue dev --env <file>` and `flue run --env <file>` load any
`.env`-format file. Update existing environment documentation or `.env.example`
when the project keeps one.

## Verify

1. Typecheck the project (`npx tsc --noEmit` is safe).
2. Build the project's configured Node target and confirm the adapter is
   discovered and wired into the generated server.
3. With `TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` set (a development database
   is fine), start the server and confirm it boots — `migrate()` creates the
   `flue_*` tables on first run. Restart it and confirm existing state is
   reloaded rather than recreated.
4. Do not point the adapter at a production database to test.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
