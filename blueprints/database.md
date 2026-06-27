---
{ "kind": "database", "version": 1, "root": true }
---

# Generic Database Adapter

## Goal

You are an AI coding agent being asked to build a Flue **database** adapter
for a backend that Flue does not have a built-in adapter for. The deliverable
is one file in the user's project that default-exports a `PersistenceAdapter`
for the backend, satisfying Flue's published contract.

A `PersistenceAdapter` stores Flue runtime state: canonical append-only agent
conversation streams, immutable external attachments,
accepted submissions and durable turn journals, workflow-run records, and event
streams. It is **not** a place for application business data. Implementing one
correctly means honoring the contract's ordering, idempotency, and lease
semantics — read the spec before writing code.

There's no fixed procedure for getting there — your backend's shape (a SQL
driver, a document store, a key-value server, an HTTP data API) will dictate
most of how you implement it. The notes below are the things you can't
reasonably infer from the spec or the worked example.

## Starting point

The user invoked `flue add database <url>` or `flue update database <url>` with
this argument as their starting point for the backend's documentation:

`{{URL}}`

It's user-provided and was passed through verbatim — it might be the docs
root, a driver reference, a GitHub repo, a marketing page, or something less
useful. Treat it as a hint, not a verified docs link, and use your judgment on
where to go from there to collect the information you need.

For an update, inspect the user's current adapter before editing. Compare it
with this refreshed complete guide, the backend's current primary sources, and
the current Flue contract. Infer which changes are relevant, apply only those
changes, preserve project-specific customizations, and update the primary
file's `flue-blueprint` marker only after the adapter conforms. A URL blueprint
has no backend-specific historical diff; do not assume the CLI compared or
modified the implementation.

## References

Read these before writing code.

- **Spec** (the `PersistenceAdapter` contract — canonical stream, attachment,
  submission, run, and event-stream stores):
  `https://flueframework.com/docs/api/data-persistence-api/index.md`
- **Worked example** (the Postgres adapter — one complete implementation of
  the full contract; your backend's shape may be quite different):
  `https://flueframework.com/cli/blueprints/postgres.md`

## Flue-specific conventions

These are the things that aren't obvious from the spec or the example.

- **Target.** A `db.ts` adapter is a **Node-target** concern. The Cloudflare
  target uses Durable Object SQLite automatically and rejects a `db.ts` file at
  build time — do not build a database adapter for a Cloudflare project.
- **File location.** The adapter is a single source-root `db.ts`, not a file
  under `sandboxes/`. Select the first existing source directory in this
  order: `<root>/.flue/`, `<root>/src/`, then `<root>/`, and write `db.ts`
  there. Its first generated line must be
  `// flue-blueprint: database/<provider>@1`, replacing `<provider>` with the
  selected provider slug. Flue discovers it at build time and wires the default
  export into the generated Node server. Ask the user if their layout is unusual.
- **Imports.** The contract types and helpers live at `@flue/runtime/adapter`.
  Don't import from `@flue/runtime/internal` or any other internal path.
- **`migrate()` runs at startup.** The generated server calls `migrate()` once
  before serving. Make schema/collection/index creation idempotent — it runs
  against fresh and already-provisioned databases alike. Stamp and check the
  schema version with the exported helpers so a database written by a newer
  Flue refuses to start rather than corrupting state.
- **Honor the durable contract, don't approximate it.** The submission store
  is the hard part: per-session FIFO ordering, single-claim under concurrency,
  idempotent dispatch admission, lease expiry, and turn-journal phases are
  load-bearing for durable recovery. Implement them against your backend's real
  primitives (transactions, conditional writes, atomic counters) rather than
  emulating them in application memory. If the backend cannot express an
  invariant safely, say so explicitly instead of shipping a lossy version.
- **Credentials.** If the backend needs a connection string or secret at
  runtime, never invent values for them. Read it from the environment
  (commonly `DATABASE_URL`) and let the project's conventions (`AGENTS.md`, an
  existing `.env`, a secret manager, CI vars) decide where it lives. Ask the
  user only if nothing in the project gives a clear signal. For local dev,
  `flue dev --env <file>` and `flue run --env <file>` load any `.env`-format
  file.

## Wrapping up

- Typecheck the project (`npx tsc --noEmit` is safe). Fix anything you broke.
- Build the project's configured Node target so the adapter is actually
  discovered and wired into the generated server.
- Tell the user what to run next: any new deps you added, the env vars the
  adapter reads, and how to point it at a real database.

## Hard rules

- Never invent connection strings, credentials, or secrets.
- Don't store the application's business data in the adapter — it holds Flue
  runtime state only.
- Don't modify files outside the `db.ts` path you've chosen unless the user
  agreed (e.g. `package.json` to add a dependency).
- The published surface is `@flue/runtime/adapter`. Don't import from
  `@flue/runtime/internal` or anywhere else.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
