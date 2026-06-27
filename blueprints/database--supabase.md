---
{ "kind": "database", "version": 1, "website": "https://supabase.com" }
---

# Add a Supabase Database to Flue

You are an AI coding agent configuring Supabase Postgres persistence for a Flue
project using the existing first-party `@flue/postgres` adapter and the `pg`
driver. Do not create a Supabase-specific package or modify `@flue/postgres`.

This persists canonical agent conversation streams, immutable attachments,
accepted submissions, workflow-run records, and event
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

Install `@flue/postgres`, `pg@^8.21.0`, and the matching `@types/pg@^8.20.0` development
dependency with the project's package manager. `@flue/postgres` does not bundle
a database driver; the project owns pooling, TLS, credentials, and connection
lifecycle.

## Choose the Supabase connection

Copy the connection string from **Supabase Dashboard > Connect** and expose it
as `SUPABASE_DATABASE_URL`. This provider-specific name keeps the source of the
secret clear; if the project has an established database variable convention,
use that convention consistently instead.

For a persistent Node server with IPv6 connectivity, use Supabase's **direct
connection**. For a persistent Node server that is IPv4-only, use the **shared
pooler in session mode**. Both preserve a server session for a checked-out `pg`
client and fit the canonical runner below.

Do not make transaction mode the default. Supabase's shared pooler in
transaction mode can preserve the explicit transaction performed on one
checked-out client, so it does not inherently break `BEGIN`/`COMMIT`. It does
not support prepared statements or session state. If the deployment requires
transaction mode, keep using unnamed `pg` queries as below: do not pass a
`name` in query configuration or otherwise enable named prepared statements,
and do not add code that depends on session state.

## Create `db.ts`

Write `<source-dir>/db.ts` with the existing transaction-safe `pg` runner. The
`transaction` callback must use one checked-out client for `BEGIN`, every query,
and `COMMIT` or `ROLLBACK`; calling the pool from inside the callback could move
work onto another connection.

```ts title="src/db.ts"
// flue-blueprint: database/supabase@1
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL });

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

Do not hardcode or invent a connection string. Follow the project's secret
conventions and never commit a real value. For local development, `flue dev
--env <file>` and `flue run --env <file>` load any `.env`-format file. Update an
existing `.env.example` or environment documentation when the project keeps
one; do not introduce a new secret-management convention without need.

`@flue/postgres` uses transaction-scoped `pg_advisory_xact_lock` calls to
serialize session updates. It does not rely on session advisory locks, and the
locks are released when their transactions complete.

## Migrations and stored state

Flue discovers `db.ts` at build time and wires its default export into the
generated Node server. The adapter's `migrate()` hook runs automatically at
startup, creates the `flue_*` tables idempotently, and stamps a schema version.
There is no separate migration command. A database written by a newer Flue
version refuses to start rather than risking incompatible writes.

The adapter stores canonical append-only conversation streams, immutable external
attachments, accepted submissions and durable turn journals, workflow-run records
and indexes, and distinct event streams. The canonical stream is the sole transcript
and is replayed from its beginning; replay acceleration and persisted-log compaction
are deferred. Sessions append for the instance lifetime and have no per-session
deletion. Whole-instance stream and attachment deletion methods are low-level primitives. It does not store sandbox
files, external API effects, provider secrets, or application business data.

## Verify

1. Typecheck the project (`npx tsc --noEmit` is safe).
2. Build the project's configured Node target and confirm `db.ts` is discovered
   and wired into the generated server.
3. Point `SUPABASE_DATABASE_URL` at a non-production Supabase project, start the
   server, and confirm `migrate()` creates the `flue_*` tables.
4. Create agent or workflow state, restart the server, and confirm that state is
   reloaded rather than recreated.
5. If using the shared pooler, confirm the selected mode matches the deployment:
   session mode by default for persistent IPv4-only Node servers; transaction
   mode only with the prepared-statement and session-state constraints above.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
