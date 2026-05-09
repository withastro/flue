---
{
  "category": "persist",
  "root": true
}
---

# Generic Persist Connector

## Goal

You are an AI coding agent being asked to build a Flue **persist** connector
for a database that Flue does not have a built-in recipe for. The deliverable
is one file in the user's project that exports a `SessionStore` for the
backend, satisfying Flue's published contract.

There's no fixed procedure for getting there — your backend's shape (typed
SDK, HTTP-only client, ORM, raw driver) will dictate most of how you
implement it. The notes below are the things you can't reasonably infer from
the contract or the worked examples.

## Starting point

The user invoked `flue add <url> --category persist` with this argument as
their starting point for the database's documentation:

`{{URL}}`

It's user-provided and was passed through verbatim — it might be a docs root,
a client-library reference, a GitHub repo, or a marketing page. Treat it as a
hint, not a verified docs link, and use your judgment on where to go from
there to collect the necessary information.

## References

Read these before writing code.

- **Contract** — the `SessionStore` interface and the `SessionData` type are
  exported from `@flue/sdk/client`. There is no separate spec document; the
  TypeScript types are authoritative. The shape:

  ```ts
  interface SessionStore {
    save(id: string, data: SessionData): Promise<void>;
    load(id: string): Promise<SessionData | null>;
    delete(id: string): Promise<void>;
  }
  ```

  `SessionData` is opaque — Flue manages its shape and may evolve it between
  releases. Persist it as a single blob and don't reach into it.

- **Worked examples** — two finished connectors. Both use the single-blob
  shape; they differ in DBMS (relational vs Cloudflare's SQLite) and in how
  the client is supplied (env-var connection string vs wrangler binding):
  - Postgres: `https://flueframework.com/cli/connectors/postgres.md`
  - D1: `https://flueframework.com/cli/connectors/d1.md`

## Flue-specific conventions

These are the things that aren't obvious from the contract or the examples.

- **File location.** `./.flue/persist/<name>.ts` if the project uses the
  `.flue/` layout, or `./persist/<name>.ts` for the root layout. Ask the
  user if their layout is unusual.
- **Imports.** `SessionStore` and `SessionData` are exported from
  `@flue/sdk/client`. Don't import from `@flue/sdk/internal` or any other
  internal path.
- **`data` is opaque.** Flue manages the shape of `SessionData` and may
  evolve it between releases. Persist it as a single JSON blob (JSONB,
  TEXT, BSON, etc. depending on the backend). Don't reach into it from the
  store, and tell the user not to query it from outside Flue either —
  they should add their own application-owned columns alongside if they
  need queryable session-level state.
- **Credentials.** If the backend needs secrets at runtime, never invent
  values for them. Let the project's conventions (`AGENTS.md`, an existing
  `.env` / `.dev.vars`, a secret manager, CI vars) decide where they
  belong, and ask the user only if nothing in the project gives a clear
  signal.
- **Client lifecycle is the user's.** Accept an already-configured client
  (Pool, Connection, binding) as the first argument; don't construct one
  inside the store. Same shape as the sandbox connectors.
- **Single-blob is the right default.** One row per session, the entire
  `SessionData` blob in one column, rewritten on every `save()`. The
  Postgres recipe walks through when to switch to an append-log shape;
  start with single-blob unless the user has specific needs.

## Wrapping up

- Typecheck the project (`npx tsc --noEmit` is safe). Fix anything you broke.
- If the user is mid-task on an agent that this store is meant to plug into,
  finish that wiring (`init({ persist: <yourStore>(client) })`). Otherwise
  share a small snippet showing how to wire it up.
- Tell the user what to run next: any new deps you added, the schema /
  migration command for their backend, env vars they need to set, and the
  command to start the agent (`flue dev` or equivalent).

## Hard rules

- Never invent connection strings, API keys, or secrets.
- Don't modify files outside the connector path you've chosen unless the
  user agreed (e.g. `package.json` to add a driver dep).
- The published surface is `@flue/sdk/client` for `SessionStore` /
  `SessionData`. Don't import from `@flue/sdk/internal` or anywhere else.
- Treat `SessionData` as opaque. Don't pretty-print, transform, or index
  into it from inside the store.
