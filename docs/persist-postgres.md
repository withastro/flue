# Persist Sessions in Postgres

This guide takes a working Flue agent on the Node target and gives it durable session state backed by Postgres — so multi-turn conversations survive process restarts, rolling deploys, and autoscaling events.

## When you'd want this

The default `InMemorySessionStore` is fine for development and stateless agents. Switch to a Postgres-backed store when:

- You're deploying to **Render, Fly, Railway, EC2 + autoscaling**, or anywhere a redeploy or rolling restart can happen mid-conversation.
- Your agent runs **multi-turn workflows** that span minutes to hours (a customer-support thread, a long research task, an async tool-call loop).
- You already operate Postgres and would rather not stand up another datastore.

If you're on Cloudflare, you don't need this — Durable Object storage handles persistence automatically. For the D1 equivalent (queryable from other Workers / admin tooling), see [Persist sessions in D1](./persist-d1.md).

## Prerequisites

You should already have a Flue project that builds and runs on the Node target. If you don't yet, start with [Deploy on Node.js](./deploy-node.md) and come back here.

You also need:

- **A reachable Postgres** (managed Postgres, a docker-compose container, anything that speaks the wire protocol).
- **The `pg` package** in your project. Install it with whatever package manager your project uses:

  ```bash
  npm install pg
  ```

## Create the table

Run this once against your database:

```sql
CREATE TABLE IF NOT EXISTS flue_sessions (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

That's the whole schema. Treat the `data` column as opaque — Flue manages its shape and may evolve `SessionData` between releases. You can pick a different table name if you prefer; the store accepts it as an option.

## Schema choices (and when to revisit them)

The schema above is the simplest shape that satisfies Flue's `SessionStore` contract: one row per session, the entire `SessionData` blob in a JSONB column, rewritten on every `save()`. It's the right default for most workloads. Two cases where you'd want something different — both are real shapes that other coding-agent CLIs converged on as their sessions got long.

### Option 1 (default): single-blob

What's above. `save(id, data)` does an `INSERT ... ON CONFLICT DO UPDATE`. `load(id)` is a single SELECT. `delete(id)` is a single DELETE.

- Pros: trivial schema, atomic save, easy to reason about, easy to back up.
- Cons: `save()` rewrites the entire blob every turn. For long sessions (50+ turns with embedded tool results) the row can grow to hundreds of KB and each save costs that much write I/O. JSONB TOAST handling absorbs a lot of this, but row churn still scales with session length.
- **Use when:** sessions are short (under ~30 turns) or low-volume, and you'd rather have a boring schema than save a few percent on writes.

### Option 2: append-log + index (matches Claude Code, Codex, OpenCode 1.2+)

Two tables instead of one. The session row holds queryable metadata (id, created/updated, project, last-leaf-id) and the message history lives in an append-only events table. `save()` appends only the new entries; `load()` reconstructs `SessionData` from the rows.

```sql
CREATE TABLE IF NOT EXISTS flue_sessions (
  id          TEXT PRIMARY KEY,
  metadata    JSONB NOT NULL DEFAULT '{}'::jsonb,
  leaf_id     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS flue_session_entries (
  session_id  TEXT NOT NULL REFERENCES flue_sessions(id) ON DELETE CASCADE,
  entry_id    TEXT NOT NULL,
  parent_id   TEXT,
  ord         BIGSERIAL,
  type        TEXT NOT NULL,
  entry       JSONB NOT NULL,
  PRIMARY KEY (session_id, entry_id)
);

CREATE INDEX IF NOT EXISTS flue_session_entries_by_session
  ON flue_session_entries (session_id, ord);
```

This is what Claude Code does with its per-session JSONL files plus a sidecar SQLite index. It's what Codex CLI does. It's what OpenCode shifted to in 1.2.

- Pros: `save()` writes only new entries (`O(delta)` instead of `O(history)`); the metadata table is queryable for admin tooling ("which sessions touched project X this week?"); `ON DELETE CASCADE` makes `delete(id)` clean; you can reconstruct the leaf path by walking `parent_id` without parsing a megabyte of JSONB.
- Cons: the adapter is more code (~120 lines instead of 50) because `save()` has to diff against the persisted entries. The Flue `SessionStore` interface today gives the adapter the *whole* `SessionData` on every save, so the adapter does the diff itself by comparing entry IDs.
- **Use when:** sessions are long (50+ turns), you have many concurrent sessions, or you want metadata queryable from outside the agent process. Most multi-tenant agent SaaS lands here eventually.

The diff strategy in `save()`: pull the existing entry IDs in one query, insert only entries whose IDs aren't there. Flue's entries are immutable once written (compaction creates a *new* entry pointing at a `firstKeptEntryId`), so this is safe.

### Option 3: hot/cold split

A third shape some teams reach for: hot session data in Redis (fast `load`/`save`), cold sessions flushed to Postgres on TTL expiry. Flue's `SessionStore` interface composes — write a wrapper store that delegates to either backend based on a TTL, and you have this without changes to Flue.

- Pros: sub-millisecond `load()` for active sessions; bounded Postgres growth.
- Cons: two systems to operate; the failure mode is "user resumes a session right as the TTL expires" — make sure the cold-write happens before the hot eviction, not after.
- **Use when:** you've got the volume to need it, and a small Redis is already in your infra.

### Recommendation

Start with Option 1. Migrate to Option 2 if you hit any of: rows over ~500 KB, sessions where `save()` is the slow path, or operational pressure to query session metadata without going through the agent. Migrate to Option 3 only when Postgres write volume is genuinely the bottleneck — which for most agent workloads, it isn't.

The store implementation below is for **Option 1**. If you want a worked Option 2 schema with the diff-on-save adapter, open an issue describing your workload and we'll either point at a community recipe or write one.

## Add the store file

Drop this file into your workspace alongside the existing connectors. Use `.flue/persist/postgres.ts` if you have the `.flue/` layout, or `./persist/postgres.ts` for the root layout. Create the parent directory if it doesn't exist.

```typescript
import type { SessionStore, SessionData } from '@flue/sdk/client';

/** Structural subset of `pg.Client` and `pg.Pool` — accepts either. */
interface PgQueryable {
  query<R = unknown>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

export interface PostgresStoreOptions {
  /** Table name. Defaults to `flue_sessions`. */
  tableName?: string;
}

/**
 * Wrap a configured `pg` Client or Pool into a Flue `SessionStore`. The user
 * owns the client lifecycle (credentials, TLS, pool sizing); this adapter
 * just translates `save / load / delete` to SQL.
 */
export function postgresStore(
  client: PgQueryable,
  options?: PostgresStoreOptions,
): SessionStore {
  const table = quoteIdent(options?.tableName ?? 'flue_sessions');

  return {
    async save(id: string, data: SessionData): Promise<void> {
      await client.query(
        `INSERT INTO ${table} (id, data, updated_at)
           VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (id) DO UPDATE
           SET data = EXCLUDED.data,
               updated_at = NOW()`,
        [id, JSON.stringify(data)],
      );
    },

    async load(id: string): Promise<SessionData | null> {
      const { rows } = await client.query<{ data: SessionData }>(
        `SELECT data FROM ${table} WHERE id = $1`,
        [id],
      );
      return rows[0]?.data ?? null;
    },

    async delete(id: string): Promise<void> {
      await client.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
    },
  };
}

function quoteIdent(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new Error(
      `[flue:postgres] Invalid table name "${name}". ` +
        'Use only letters, digits, and underscores; must not start with a digit.',
    );
  }
  return `"${name}"`;
}
```

## Wire it into your agent

Pass the store via `init({ persist })`:

```typescript
import type { FlueContext } from '@flue/sdk';
import pg from 'pg';
import { postgresStore } from '../persist/postgres';

export const triggers = { webhook: true };

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({
    model: 'anthropic/claude-sonnet-4-6',
    persist: postgresStore(pool),
  });
  const session = await agent.session(payload.threadId);
  return await session.prompt(payload.message);
}
```

The session id (`payload.threadId` here) is whatever your application uses to identify a conversation thread — typically a customer ID, a chat-room ID, or anything else stable across requests. Flue keys session storage on this id.

## Verify locally

The fastest path to a working setup is `docker-compose` with a throwaway Postgres:

```yaml
# docker-compose.yml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_PASSWORD: flue
    ports: ['5432:5432']
```

```bash
docker compose up -d
DATABASE_URL=postgres://postgres:flue@localhost:5432/postgres \
  npx flue run with-postgres-persist --target node --id thread-1 \
  --payload '{"threadId":"thread-1","message":"My name is Maya."}'

DATABASE_URL=postgres://postgres:flue@localhost:5432/postgres \
  npx flue run with-postgres-persist --target node --id thread-1 \
  --payload '{"threadId":"thread-1","message":"What did I just say my name was?"}'
```

The second invocation should reference "Maya" — that's the round-trip working. Inspect the row directly to confirm:

```bash
docker compose exec postgres psql -U postgres \
  -c "SELECT id, jsonb_array_length(data->'entries') AS entries, updated_at FROM flue_sessions;"
```

## What Flue manages vs what you manage

| Flue manages | You manage |
|---|---|
| The shape of `SessionData` (entries, leafId, metadata, compaction state) | The Postgres database — provisioning, credentials, TLS, backups |
| The `SessionStore` interface contract | The `pg` client lifecycle — pool sizing, connection management, teardown |
| When `save` / `load` / `delete` are called | Schema migrations if you customize the table |
| Compaction — the `data` column may shrink over time | Indexes on `data` if you query into the JSON yourself |

Flue treats `data` as opaque. Don't query into it from application code — internal shape is not a stable interface and may change between releases. Add your own columns if you need queryable session-level state (e.g. a `customer_id TEXT` column populated from your application).

## Concurrency

The store is **last-writer-wins** on `save(id, data)`. Within a single Node process Flue gates concurrent operations on the same session via `runExclusive`, so two `prompt`/`skill`/`task` calls on the same `Session` instance don't race. **Across processes** — multi-instance Render service, multiple workers behind a load balancer — two saves for the same session id can interleave, and the last commit wins.

If your application routes multiple in-flight requests for the same session id to multiple processes, fence at your application layer:

- **Sticky routing.** Load-balancer hashing on the session id sends the same id to the same process; combined with Flue's `runExclusive`, this is sufficient.
- **Application-level lock.** A small Redis-or-similar lock around the Flue handler. Most agent workloads don't need this.

The store does not implement optimistic concurrency or distributed locks. If you need them, build them on top — or open an issue describing the workload.

## Troubleshooting

**`relation "flue_sessions" does not exist`** — run the `CREATE TABLE` from the [Create the table](#create-the-table) section.

**`cannot find module 'pg'`** — install it: `npm install pg`. Real projects import `pg` statically at the top of the agent (so the import error fails the build rather than the request); the `postgresStore` recipe doesn't import `pg` itself.

**Sessions disappear between requests** — confirm the same `payload.threadId` (or whatever you key on) is being passed to `agent.session(id)`. If the id changes per request, every call starts a fresh session.

**`SyntaxError: Unexpected token in JSON`** — `JSON.parse` failed in the SDK because the row's `data` column is malformed. Most often this happens because someone wrote into the column from outside Flue. Treat `data` as opaque.

## Other databases

`postgresStore` is a small adapter — about 50 lines of code. Adapting it to MySQL, SQLite, MongoDB, DynamoDB, or Redis is mostly mechanical: implement `save` / `load` / `delete` against your client of choice. The schema-choice trade-offs above carry across — most relational backends fit Option 1 or Option 2, most KV backends fit Option 3 cleanly. If you ship one, consider opening a pull request with a docs guide modeled on this one.
