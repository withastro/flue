---
{
  "category": "persist",
  "website": "https://developers.cloudflare.com/d1"
}
---

# Add a Flue Connector: Cloudflare D1 Session Store

You are an AI coding agent installing the Cloudflare D1 session-store
connector for a Flue project. Follow these instructions exactly. Confirm
with the user only when something is genuinely ambiguous (e.g. an unusual
project layout).

## What this connector does

Wraps a Cloudflare D1 binding into Flue's `SessionStore` interface, so
agent sessions on the Cloudflare target are persisted in D1 instead of
the per-agent Durable Object's storage. The user owns the wrangler binding;
this connector translates Flue's `save / load / delete` calls to SQL.

This is the right choice when the agent runs on the **Cloudflare target**
and the team needs sessions queryable from a different Worker (admin
dashboards, BI exports, multi-Worker apps). If those needs don't apply,
stick with the default DO-SQLite store — it's faster, simpler, and ships
out of the box. For Node deployments, install the `postgres` connector
instead.

## Where to write the file

Pick the location based on the user's project layout:

- **`.flue/` layout** (project has files at the root and uses `.flue/agents/`
  etc.): write to `./.flue/persist/d1.ts`.
- **Root layout** (the project root itself contains `agents/` and friends):
  write to `./persist/d1.ts`.

If neither feels right (uncommon layout, multiple workspaces, etc.), ask the
user before writing.

Create any missing parent directories.

## File contents

Write this file verbatim. Do not "improve" it — it conforms to the published
`SessionStore` contract.

```ts
import type { SessionStore, SessionData } from '@flue/sdk/client';

/** Structural subset of Cloudflare's `D1Database`. */
interface D1Like {
	prepare(sql: string): {
		bind(...values: unknown[]): {
			first<T = unknown>(): Promise<T | null>;
			run(): Promise<unknown>;
		};
	};
}

export interface D1StoreOptions {
	/** Table name. Defaults to `flue_sessions`. */
	tableName?: string;
}

/**
 * Wrap a Cloudflare D1 binding into a Flue `SessionStore`. Pass `env.DB`
 * (or whatever your binding name is). Typed as `unknown` to match the
 * convention used by `getVirtualSandbox(bucket: unknown)` in the same
 * package — users with `@cloudflare/workers-types` installed pass a
 * `D1Database`, users without it work fine too.
 */
export function d1Store(db: unknown, options?: D1StoreOptions): SessionStore {
	const table = quoteIdent(options?.tableName ?? 'flue_sessions');
	const d1 = asD1Like(db);

	return {
		async save(id: string, data: SessionData): Promise<void> {
			await d1
				.prepare(
					`INSERT INTO ${table} (id, data, updated_at)
             VALUES (?1, ?2, ?3)
           ON CONFLICT(id) DO UPDATE SET
             data = excluded.data,
             updated_at = excluded.updated_at`,
				)
				.bind(id, JSON.stringify(data), Date.now())
				.run();
		},

		async load(id: string): Promise<SessionData | null> {
			const row = await d1
				.prepare(`SELECT data FROM ${table} WHERE id = ?1`)
				.bind(id)
				.first<{ data: string }>();
			return row ? (JSON.parse(row.data) as SessionData) : null;
		},

		async delete(id: string): Promise<void> {
			await d1.prepare(`DELETE FROM ${table} WHERE id = ?1`).bind(id).run();
		},
	};
}

function asD1Like(db: unknown): D1Like {
	if (
		db === null ||
		typeof db !== 'object' ||
		typeof (db as { prepare?: unknown }).prepare !== 'function'
	) {
		throw new Error(
			'[flue:d1] Expected a Cloudflare D1 binding. Pass env.DB ' +
				'(or your configured binding name) to d1Store().',
		);
	}
	return db as D1Like;
}

// Duplicated in postgres.ts on purpose — these recipes are copied
// independently into user projects, so they don't share a helper module.
function quoteIdent(name: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
		throw new Error(
			`[flue:d1] Invalid table name "${name}". ` +
				'Use only letters, digits, and underscores; must not start with a digit.',
		);
	}
	return `"${name}"`;
}
```

## Required dependencies

None. D1 ships with the Workers runtime — no SDK install needed.

## Credentials

This connector needs a D1 database, declared as a binding in the user's
`wrangler.jsonc`. There's no API key — Cloudflare resolves the binding at
deploy time. **Never invent a `database_name` or `database_id`** — they
come from the user running `npx wrangler d1 create <name>`.

If `wrangler.jsonc` doesn't already declare a D1 binding, surface it and
let the user choose the name. The conventional shape:

```jsonc
"d1_databases": [
  { "binding": "DB", "database_name": "<name>", "database_id": "<id>" }
]
```

The binding name (`DB` here) is what shows up on `env`. If the user picks a
different name, the agent file's `env.DB` reference must change to match.
For local dev, Flue's Cloudflare dev server resolves the same binding against
a local SQLite file (`--local`, the default) through the generated
`dist/wrangler.jsonc`.

## Schema

The store expects this table. Run it once against the user's D1, both
remote and local:

```bash
npx wrangler d1 execute <name> --remote --command="
  CREATE TABLE IF NOT EXISTS flue_sessions (
    id          TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
"
```

For local development, first run `npx flue build --target cloudflare`, then
run the local schema command against the generated config Flue will hand to
Wrangler:

```bash
(cd dist && npx wrangler d1 execute <name> --local --config wrangler.jsonc --command="
  CREATE TABLE IF NOT EXISTS flue_sessions (
    id          TEXT PRIMARY KEY,
    data        TEXT NOT NULL,
    updated_at  INTEGER NOT NULL
  );
")
```

Local D1 state is keyed by Wrangler's config path. Flue's Cloudflare dev
server uses `dist/wrangler.jsonc`, not the project-root `wrangler.jsonc`, so
running the local migration against the root config creates a different local
SQLite file.

The schema intentionally mirrors the table the default DO-SQLite store creates
inside each agent's Durable Object — same column names, same types — so a
future migration tool could move rows between the two without translation.

Treat `data` as opaque — Flue manages its shape and may evolve `SessionData`
between releases. The table name can be customized via `tableName` in the
store options; the schema is otherwise fixed.

## Wiring it into an agent

Here's what using this connector looks like inside a Flue agent. If the
user is already working on an agent that this connector is meant to plug
into, you can finish that work by wiring the connector into it. Otherwise,
share this snippet so they can wire it up themselves.

```ts
import type { FlueContext } from '@flue/sdk';
import { d1Store } from '../persist/d1'; // adjust path to match the user's layout

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

The session id (`payload.threadId` here) is whatever the application uses to
identify a conversation thread.

## Verify

1. Run the user's typechecker (`npx tsc --noEmit` is a safe default) and
   confirm the new file has no errors.
2. Confirm the import path you used for the connector matches where you
   actually wrote the file, and that `env.DB` matches the `binding` value
   in `wrangler.jsonc`.
3. Tell the user the next steps: run `npx wrangler d1 create <name>` if
   they haven't yet, update the binding in `wrangler.jsonc` with the printed
   `database_id`, run the `CREATE TABLE` for `--remote`, run
   `npx flue build --target cloudflare`, run the local `CREATE TABLE` against
   `dist/wrangler.jsonc`, then `npx flue dev --target cloudflare` to exercise
   it on `http://localhost:3583`.

For deeper reference (D1 vs DO-SQLite trade-offs, schema alternatives,
troubleshooting), point the user at the docs guide:
`https://github.com/withastro/flue/blob/main/docs/persist-d1.md`.
