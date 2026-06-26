# `@flue/mysql`

MySQL 8 and InnoDB durable persistence for Flue applications on the Node.js
target.

```ts
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

Default-export the adapter from a source-root `db.ts`. Flue discovers it at
build time and wires it into the generated Node server. The adapter's
`migrate()` hook runs at startup, creates and verifies its InnoDB tables
idempotently, and then stamps the schema version. There is no separate migration
command.

This adapter persists Flue runtime state:

- the canonical append-only conversation stream for each agent instance;
- disposable conversation snapshots and immutable external attachments;
- accepted direct prompts and `dispatch(...)` submissions, including durable
  turn journals, claims, and leases;
- workflow-run records, event streams, and run indexing.

The canonical stream is the sole transcript. Sessions append for the instance
lifetime and have no per-session deletion. Whole-instance stream, snapshot, and
attachment deletion methods are low-level primitives, not public orchestration.

It does not store application business data, external API side effects, or
provider credentials.

## Bring your own driver

`@flue/mysql` does **not** pick or bundle a production database driver. It runs
against a small runner around your configured driver, so you own pooling, TLS,
credentials, and connection lifecycle.

A runner has three functions:

- `query(text, params)` runs SQL with `?` placeholders and returns result rows as
  plain objects. With `mysql2`, use `pool.execute()` and return an empty array
  for non-row results.
- `transaction(fn)` checks out one connection, begins a transaction, uses only
  that connection for every callback query, commits on resolve, rolls back on
  throw, and releases after commit or rollback.
- `close()` closes the underlying driver; for a `mysql2` pool, call `pool.end()`.

The example above is the canonical `mysql2` integration. Do not issue callback
queries through the pool: a pool may select a different connection and move the
query outside the transaction.

## Database requirements

Use MySQL 8 with InnoDB for every Flue table. InnoDB provides the transactions
and row locking required for durable admission, claims, leases, and
event ordering. Supply `MYSQL_URL` through the application's secret system and
configure TLS in `mysql2` when required by the database provider. Never commit a
real connection string.

## When to use it

Use `@flue/mysql` when state must survive host replacement, be shared by
multiple Node replicas, or fit an existing MySQL 8 operational environment. For
a single host, file-backed `sqlite()` from `@flue/runtime/node` may be simpler.

## Target support

This adapter targets **Node.js only**. The Cloudflare target uses Durable Object
SQLite automatically and rejects `db.ts` at build time.

## Installation

```sh
flue add database mysql
```

The blueprint installs `@flue/mysql` and `mysql2`, then writes `db.ts`. See the
[MySQL guide](https://flueframework.com/docs/ecosystem/databases/mysql/) for
setup and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/)
for the adapter contract.
