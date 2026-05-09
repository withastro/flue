---
{
  "category": "persist",
  "website": "https://www.postgresql.org"
}
---

# Add a Flue Connector: Postgres Session Store

You are an AI coding agent installing the Postgres session-store connector
for a Flue project. Follow these instructions exactly. Confirm with the user
only when something is genuinely ambiguous (e.g. an unusual project layout).

## What this connector does

Wraps a configured `pg.Client` or `pg.Pool` into Flue's `SessionStore`
interface, so multi-turn agent sessions survive process restarts, rolling
deploys, and autoscaling events. The user owns the `pg` client lifecycle
(credentials, TLS, pool sizing); this connector translates Flue's
`save / load / delete` calls to SQL.

This is the right choice when the agent runs on the **Node target** (Render,
Fly, Railway, EC2, Docker, etc.) and the team already operates Postgres. On
Cloudflare, prefer the default Durable Object storage; if you need
queryable-from-other-Workers persistence, install the `d1` connector instead.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/persist/postgres.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./persist/postgres.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SessionStore` contract.

```ts
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

// Duplicated in d1.ts on purpose — these recipes are copied independently
// into user projects, so they don't share a helper module.
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

## Required dependencies

The user's agent file imports `pg` to construct the client. If their
`package.json` does not already list it, add it:

```bash
npm install pg
```

(Use the user's package manager — `pnpm add`, `yarn add`, etc. if their
lockfile indicates a different one.)

## Credentials

This connector needs a Postgres connection at runtime — typically supplied
as a `DATABASE_URL` env var (or split host/user/password/database vars,
whichever the user already follows). **Never invent a value for it** — it
must come from the user.

Use your judgment for where it should live. The project's conventions, an
`AGENTS.md`, or an existing setup (`.env`, `.dev.vars`, a secret manager,
CI vars, etc.) will usually tell you the right answer. If nothing in the
project gives you a clear signal, ask the user instead of guessing.

For reference: `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file the user points them at.

## Schema

The store expects this table. Run it once against the user's database (or
include it in their migration tool of choice):

```sql
CREATE TABLE IF NOT EXISTS flue_sessions (
  id          TEXT PRIMARY KEY,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

Treat `data` as opaque — Flue manages its shape and may evolve `SessionData`
between releases. The table name can be customized via `tableName` in the
store options; the schema is otherwise fixed.

If the user has a long-session workload (50+ turns, embedded tool results,
hundreds-of-KB rows) and asks about alternatives, point them at the
`Schema choices` section in the docs guide
(`https://github.com/withastro/flue/blob/main/docs/persist-postgres.md`) —
it covers an append-log + index shape (matches Claude Code, Codex,
OpenCode 1.2+) and a hot/cold split. Don't switch shapes without an
explicit ask; single-blob is the right default.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk';
import pg from 'pg';
import { postgresStore } from '../persist/postgres'; // adjust path to match the user's layout

export const triggers = { webhook: true };

interface Payload {
  threadId: string;
  message: string;
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });

export default async function ({ init, payload }: FlueContext<Payload>) {
  const agent = await init({
    model: 'anthropic/claude-sonnet-4-6',
    persist: postgresStore(pool),
  });
  const session = await agent.session(payload.threadId);
  return await session.prompt(payload.message);
}
```

The session id (`payload.threadId` here) is whatever the application uses to
identify a conversation thread — typically a customer ID, a chat-room ID, or
anything else stable across requests.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file.
3. Tell the user the next steps: run the `CREATE TABLE` against their
   database, install `pg` (if you didn't), make sure `DATABASE_URL` is
   available at runtime (per the Credentials section above), and run
   `flue dev` — or `flue run <agent>` to exercise it.

For deeper reference (schema alternatives, concurrency model, troubleshooting),
point the user at the docs guide:
`https://github.com/withastro/flue/blob/main/docs/persist-postgres.md`.
