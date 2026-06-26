# `@flue/postgres`

Postgres-backed durable persistence for Flue applications on the Node.js target.

```ts
// src/db.ts
import { postgres, type PostgresQuery } from '@flue/postgres';
import sql from 'postgres';

const db = sql(process.env.DATABASE_URL!);

export default postgres({
  query: (text, params) => db.unsafe(text, params),
  transaction: <T>(fn: (tx: { query: PostgresQuery }) => Promise<T>) =>
    db.begin((tx) => fn({ query: (text, params) => tx.unsafe(text, params) })) as Promise<T>,
  close: () => db.end(),
});
```

Default-export the adapter from a source-root `db.ts`. Flue discovers it at
build time and wires it into the generated Node server. The adapter's
`migrate()` hook runs once at startup and creates its tables idempotently, so
there is no separate migration step.

This adapter persists Flue runtime state:

- the canonical append-only conversation stream for each agent instance;
- disposable conversation snapshots and immutable external attachments;
- accepted direct prompts and `dispatch(...)` submissions, with durable turn
  journals and leases;
- workflow-run records, event streams, and run indexing.

The canonical stream is the sole transcript. Sessions append for the instance
lifetime and have no per-session deletion. Whole-instance stream, snapshot, and
attachment deletion methods are low-level primitives, not public orchestration.

It does not store your application's business data. Keep customer records,
tickets, and payments in your own tables.

## Bring your own driver

`@flue/postgres` does **not** pick or bundle a database driver. It runs against
a small runner you wrap around your configured driver, so you own driver
choice, pooling, TLS, and every other connection option.

A runner is three functions:

- `query(text, params)` — run a SQL string with numbered `$N` placeholders and
  positional parameters, resolving to the result rows as plain objects.
- `transaction(fn)` — run `fn` inside a single transaction on one connection,
  committing on resolve and rolling back on throw. The `tx` passed to `fn` only
  needs `query`.
- `close()` — close the underlying driver.

The example above wraps the [`postgres`](https://github.com/porsager/postgres)
(porsager) driver. With [`pg`](https://node-postgres.com/) (node-postgres),
`transaction` checks out a single client and issues `BEGIN`/`COMMIT`/`ROLLBACK`
itself (a pool cannot run a transaction across arbitrary connections):

```ts
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

## When to use it

Reach for `@flue/postgres` when state must survive host replacement or be
shared across multiple application replicas — for example, when another Node
process must recover accepted work after a host failure, or when several
replicas need the same workflow-run history. For a single host, the built-in
file-backed `sqlite()` adapter from `@flue/runtime/node` is enough.

## Target support

This adapter targets **Node.js**. The Cloudflare target uses Durable Object
SQLite automatically and rejects a `db.ts` file at build time, so a database
adapter does not apply there.

## Installation

```sh
flue add database postgres
```

`flue add database postgres` installs the package, helps you pick a driver, and writes
the `db.ts`. See the [Postgres guide](https://flueframework.com/docs/ecosystem/databases/postgres/)
for setup and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/)
for the adapter contract.
