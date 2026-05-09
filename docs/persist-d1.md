# Persist Sessions in D1

This guide takes a working Flue agent on the Cloudflare target and gives it durable session state backed by [Cloudflare D1](https://developers.cloudflare.com/d1/) — useful when sessions need to be queryable from outside the agent process (admin dashboards, separate UI Workers, BI exports).

## When you'd want this

By default, Flue agents on Cloudflare persist sessions automatically via the per-agent Durable Object's storage. That's the fast path — sub-millisecond reads, strong consistency, no extra binding to configure. Switch to D1 when you need:

- **Sessions queryable from a different Worker.** A separate UI/admin Worker can read agent sessions without the per-agent DO becoming a bottleneck.
- **Sessions queryable across all agents in one query.** "Show me every session that mentioned product X this week" is a single SQL query against D1, vs. iterating every DO.
- **A familiar SQL surface for downstream tooling.** D1 exports cleanly to BI; DO storage doesn't.

If none of those apply, stick with the default DO-SQLite store — it's faster, simpler, and ships out of the box.

## Prerequisites

You should already have a Flue project that builds and runs on the Cloudflare target. If you don't yet, start with [Deploy on Cloudflare](./deploy-cloudflare.md).

You also need:

- **A D1 database.** Create one with `npx wrangler d1 create <name>` and bind it in your `wrangler.jsonc`:

  ```jsonc
  "d1_databases": [
    { "binding": "DB", "database_name": "<name>", "database_id": "<id>" }
  ]
  ```

  No SDK install is needed — D1 ships with the Workers runtime.

## Install the connector

Install the D1 session-store connector with `flue add`. Always pass `--print` — it's the safe default whether you're a human pasting the output into your coding agent of choice, or an agent running this command yourself:

```bash
# Print the install instructions and let your agent (or you) handle the rest
flue add d1 --print

# Or pipe directly to a coding agent
flue add d1 --print | claude
```

This drops a `persist/d1.ts` file into your workspace (under `.flue/persist/` if you're using the `.flue/` layout, or `persist/` at the project root otherwise) and walks the agent through the schema, `wrangler.jsonc` binding, and agent wiring.

The connector is a small TypeScript adapter (~50 lines) that wraps a Cloudflare D1 binding into Flue's `SessionStore` interface.

## Create the table

The connector instructions include the schema, but for reference:

```bash
npx wrangler d1 execute <name> --remote --command="
  CREATE TABLE IF NOT EXISTS flue_sessions (
    id          TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
"
```

For local development, swap `--remote` for `--local`. The schema intentionally mirrors the table the default DO-SQLite store creates inside each agent's Durable Object — same column names, same types — so a future migration tool could move rows between the two without translation.

## Use the store in your agent

The connector instructions include the agent-wiring snippet, but for reference:

```typescript
import type { FlueContext } from '@flue/sdk';
import { d1Store } from '../persist/d1';

export const triggers = { webhook: true };

interface Payload {
  threadId: string;
  message: string;
}

export default async function ({ init, payload, env }: FlueContext<Payload>) {
  const agent = await init({
    model: 'anthropic/claude-sonnet-4-6',
    persist: d1Store(env.DB),
  });
  const session = await agent.session(payload.threadId);
  return await session.prompt(payload.message);
}
```

The session id (`payload.threadId` here) is whatever your application uses to identify a conversation thread. Flue keys session storage on this id.

## Verify locally

Use `wrangler dev` with the `--local` D1 (default):

```bash
npx wrangler d1 execute <name> --local --command="
  CREATE TABLE IF NOT EXISTS flue_sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
"
npx flue dev --target cloudflare
```

Then, in another shell:

```bash
curl -X POST http://localhost:8787/agents/with-d1-persist/thread-1 \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"thread-1","message":"My name is Maya."}'

curl -X POST http://localhost:8787/agents/with-d1-persist/thread-1 \
  -H 'Content-Type: application/json' \
  -d '{"threadId":"thread-1","message":"What did I just say my name was?"}'
```

The second response should reference "Maya" — that's the round-trip working. Inspect the row directly to confirm:

```bash
npx wrangler d1 execute <name> --local \
  --command="SELECT id, length(data), updated_at FROM flue_sessions;"
```

## Schema choices (and when to revisit them)

The schema above is the simplest shape that satisfies Flue's `SessionStore` contract: one row per session, the entire `SessionData` blob in a TEXT column, rewritten on every `save()`. Same trade-offs as the [Postgres single-blob option](./persist-postgres.md#schema-choices-and-when-to-revisit-them) — see that section for the append-log + index alternative (matches Claude Code, Codex, OpenCode 1.2+) and the hot/cold split. The D1 versions of those alternatives map directly: `JSONB` → `TEXT`, `BIGSERIAL` → `INTEGER PRIMARY KEY AUTOINCREMENT`, `?1, ?2` instead of `$1, $2`.

For most workloads, start with the single-blob shape — that's what the connector ships. Migrate to append-log only when you hit row size pressure or need to query session metadata at scale.

## D1 vs the default DO-SQLite store

The default DO-SQLite store (used automatically when you don't pass `persist`) and `d1Store` solve overlapping problems with different trade-offs:

| Dimension | Default DO-SQLite | D1 store |
|---|---|---|
| Setup | Zero — automatic | Create database + binding + table |
| Read latency | Sub-millisecond (in-memory tier) | Single-digit milliseconds |
| Write latency | Sub-millisecond | Single-digit milliseconds |
| Queryable from another Worker? | No — DO-private | Yes |
| Queryable across all sessions? | No — per-DO scope | Yes (one D1, all rows) |
| BI / admin tooling | Manual export | Native SQL export |
| Cost | Included in DO usage | D1 reads/writes billed separately |
| Best for | Hot-path session resume | Multi-Worker apps, admin dashboards, analytics |

You can use both. Make the agent default to DO-SQLite (don't pass `persist`) for hot reads, and run a small periodic Worker that mirrors completed sessions into D1 for analytics.

## What Flue manages vs what you manage

| Flue manages | You manage |
|---|---|
| The shape of `SessionData` | The D1 database — creation, binding, billing |
| The `SessionStore` interface contract | The wrangler binding name (`DB` here) |
| When `save` / `load` / `delete` are called | Schema migrations if you customize the table |
| Compaction — the `data` column may shrink over time | Indexes if you query into `data` yourself |

Treat `data` as opaque. Don't query into it from application code — internal shape is not a stable interface and may change between releases. Add your own columns if you need queryable session-level state (e.g. a `customer_id TEXT` column populated from your application).

## Concurrency

Same model as the [Postgres guide](./persist-postgres.md#concurrency): `INSERT ... ON CONFLICT(id) DO UPDATE` is last-writer-wins on `save(id, data)`. Within a single Worker instance Flue gates concurrent operations on the same session via `runExclusive`. Across instances — D1 is shared, so concurrent saves can interleave and the last commit wins. Cloudflare's request routing typically sends the same session id to the same Worker instance via the agent DO, so cross-instance races are rare; if your application routes outside the Flue handler, fence at the application layer.

## Troubleshooting

**`no such table: flue_sessions`** — run the `CREATE TABLE` for your environment. Local DB is separate from remote — you may need both.

**`D1_ERROR: ...`** — D1 errors carry the underlying SQLite error class. Most often it's the missing-table case above; otherwise check the SQL against [D1's SQLite dialect notes](https://developers.cloudflare.com/d1/sql-api/sql-statements/).

**Sessions disappear between requests** — confirm the same `payload.threadId` is being passed to `agent.session(id)`. If the id changes per request, every call starts a fresh session.

**`SyntaxError: Unexpected token in JSON`** — `JSON.parse` failed because the row's `data` column is malformed. Most often happens because someone wrote into the column from outside Flue. Treat `data` as opaque.

## Other databases

`d1Store` is small (~50 lines). Adapting it to a different SQLite-compatible backend (Turso, libSQL, raw `better-sqlite3`) is mostly mechanical: swap `db.prepare(...).bind(...).run()` for the equivalent on your client. The schema-choice trade-offs above carry across.

If Flue doesn't have a built-in connector for your backend yet, `flue add <docs-url> --category persist` will pipe a generic recipe to your agent. If you ship one, consider opening a pull request with both the connector (`connectors/persist--<name>.md`) and a docs guide modeled on this one or the [Postgres guide](./persist-postgres.md).
