---
{ "kind": "database", "version": 1, "website": "https://www.mysql.com" }
---

# Add a MySQL Database to Flue

You are an AI coding agent configuring MySQL-backed persistence for a Flue
project using the first-party `@flue/mysql` adapter. This adapter supports
MySQL 8 with InnoDB tables.

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

## Install the adapter and driver

Install `@flue/mysql` and [`mysql2@^3.22.5`](https://sidorares.github.io/node-mysql2/docs)
with the project's package manager. `@flue/mysql` is driver-free at runtime;
the project owns pooling, TLS, credentials, and connection lifecycle.

## Create `db.ts`

Write `<source-dir>/db.ts` with this pool-backed runner. Normal queries use
`pool.execute()`. Transactions check out one connection and use only that
connection until commit or rollback completes, then release it. Convert
`mysql2` result rows to plain objects before returning them.

```ts title="src/db.ts"
// flue-blueprint: database/mysql@1
import { mysql, type MysqlQuery } from '@flue/mysql';
import mysql2 from 'mysql2/promise';

const pool = mysql2.createPool(process.env.MYSQL_URL!);

const toRows = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result.map((row) => ({ ...row })) : [];

export default mysql({
  query: async (text, params = []) => {
    const [result] = await pool.execute(text, params);
    return toRows(result);
  },
  transaction: async <T>(fn: (tx: { query: MysqlQuery }) => Promise<T>) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn({
        query: async (text, params = []) => {
          const [rows] = await connection.execute(text, params);
          return toRows(rows);
        },
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
  close: () => pool.end(),
});
```

Do not replace `pool.getConnection()` with top-level pool calls inside the
transaction callback. A transaction must remain on one checked-out connection.
Do not hardcode or invent a connection string; `MYSQL_URL` (or the project's
existing equivalent) is supplied by the environment.

Flue discovers `db.ts` at build time and wires the default export into the
generated Node server. The adapter's `migrate()` hook runs automatically at
startup. It creates and verifies the complete InnoDB schema before stamping its
version, so there is no separate migration command. Do not add an `app.ts`
solely to register the database.

## Credentials and deployment

Use MySQL 8 with InnoDB for every Flue table. Supply `MYSQL_URL` through the
project's existing secret system and configure TLS in `mysql2` as required by
the database provider. Never commit a real connection string. For local
development, `flue dev --env <file>` and `flue run --env <file>` load any
`.env`-format file.

## Verify

1. Typecheck the project (`npx tsc --noEmit` is safe).
2. Build the configured Node target and confirm the adapter is discovered.
3. Point `MYSQL_URL` at a throwaway MySQL 8 database whose tables use InnoDB.
4. Start the server and confirm `migrate()` creates the `flue_*` tables. Restart
   it and confirm existing state is reloaded.
5. Do not point the adapter at a production database to test.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
