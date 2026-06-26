---
{ "kind": "database", "version": 1, "website": "https://www.postgresql.org" }
---

# Add a Postgres Database to Flue

You are an AI coding agent configuring Postgres-backed persistence for a Flue
project using the first-party `@flue/postgres` adapter.

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
then `<root>/`. Check for an existing `db.ts` in that root — if one is present,
the project already has an adapter; confirm with the user before replacing it.
Inspect how the project reads secrets so the connection string follows the same
convention.

## Choose and install a driver

`@flue/postgres` does **not** bundle a database driver. It runs against a small
runner you wrap around the Postgres driver the project chooses, so the project
owns driver selection, pooling, TLS, and every connection option.

Install `@flue/postgres` plus one Postgres driver. If the project already
depends on a Postgres driver, reuse it. Otherwise use
[`pg@^8.21.0`](https://node-postgres.com/) (node-postgres) and install the matching
`@types/pg@^8.20.0` development dependency. Ask the user before choosing a different
driver when the choice is consequential for their deployment.

## Create `db.ts`

Write `<source-dir>/db.ts` with a default-exported adapter that wraps the chosen
driver in the runner shape — `query` (a SQL string with numbered `$N`
placeholders plus positional params, resolving to result rows), a `transaction`
that runs its callback inside one transaction on a single connection, and
`close`.

With `pg` (node-postgres), `transaction` must check out a single client and
issue `BEGIN`/`COMMIT`/`ROLLBACK` itself — a pool cannot run a transaction
across arbitrary connections:

```ts title="src/db.ts"
// flue-blueprint: database/postgres@1
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({ query: async (t, p) => (await client.query(t, p)).rows });
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

Do not hardcode a connection string, and do not invent one — `DATABASE_URL` (or
the project's existing equivalent) is supplied by the environment.

Flue discovers `db.ts` at build time and wires the default export into the
generated Node server. The adapter's `migrate()` hook runs automatically at
startup and creates its tables idempotently, so there is no separate migration
step to run. Do not add an `app.ts` solely to register the database.

## Credentials

The driver reads `DATABASE_URL` at runtime. Follow the project's secret
conventions and never commit a real connection string. For local development,
`flue dev --env <file>` and `flue run --env <file>` load any `.env`-format file.
Update existing environment documentation or `.env.example` when the project
keeps one; don't introduce a new secret-management convention without need.

## Verify

1. Typecheck the project (`npx tsc --noEmit` is safe).
2. Build the project's configured Node target and confirm the adapter is
   discovered and wired into the generated server.
3. With `DATABASE_URL` pointed at a reachable Postgres (a local container is
   fine), start the server and confirm it boots — `migrate()` creates the
   `flue_*` tables on first run. Restart it and confirm existing state is
   reloaded rather than recreated.
4. Do not point the adapter at a production database to test.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
