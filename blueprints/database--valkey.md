---
{ "kind": "database", "version": 1, "website": "https://valkey.io" }
---

# Add a Valkey Database to Flue

You are an AI coding agent configuring Valkey-backed persistence for a Flue
project using the first-party `@flue/redis` adapter and the official Redis
`redis` (node-redis) client. Valkey implements the Redis protocol and command
surface used by this adapter. This blueprint supports Valkey specifically; do
not infer support for every service described as Redis-compatible.

This stores canonical agent conversation streams, disposable snapshots,
immutable attachments, accepted submissions, workflow-run records, and event
streams. It does not store application business data.

## Check the target and deployment

A `db.ts` adapter is a **Node-target** concern. The Cloudflare target uses
Durable Object SQLite automatically and rejects `db.ts` at build time. If this
project targets Cloudflare, stop and tell the user — there is nothing to add.

Use a persistent standalone Valkey server or managed single-shard endpoint with
`maxmemory-policy noeviction`. Valkey Cluster and cache-only configurations are
unsupported. Enable AOF with an explicit fsync policy and/or durable snapshots
appropriate to the recovery objective: `noeviction` prevents eviction but does
not make acknowledged writes durable across server loss.

## Inspect the project

Read local instructions (`AGENTS.md` and similar), detect the package manager,
and select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Check for an existing `db.ts`; if one is present, confirm with
the user before replacing it. Inspect the project's secret conventions.

Install `@flue/redis` and the official `redis@^5.12.1` client with the project's package
manager. `@flue/redis` does not bundle a production client; the project owns
credentials, TLS, timeouts, reconnect behavior, and topology.

## Create `db.ts`

Write `<source-dir>/db.ts` with this complete runner. Its pipeline returns one
normalized result per command and rejects any `Error` result.

```ts title="src/db.ts"
// flue-blueprint: database/valkey@1
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.VALKEY_URL });
await client.connect();

export default redis({
  command: (command, args = []) => client.sendCommand([command, ...args.map(String)]),
  eval: (script, keys, args = []) =>
    client.eval(script, {
      keys,
      arguments: args.map(String),
    }),
  pipeline: async (commands) => {
    const multi = client.multi();
    for (const { command, args = [] } of commands) {
      multi.addCommand([command, ...args.map(String)]);
    }
    const results = await multi.exec();
    for (const result of results) {
      if (result instanceof Error) throw result;
    }
    return results;
  },
  close: () => client.close(),
});
```

Do not hardcode or invent a connection string. Read `VALKEY_URL` or the project's
existing equivalent from its secret system and never commit credentials.

Flue discovers `db.ts` and runs the adapter's `migrate()` hook at server startup.
Migration inspects the server, initializes the schema-version metadata key
idempotently, and rejects data written by an unsupported newer schema. There is
no separate migration command.

By default, `inspectServer` uses `CONFIG GET` and falls back to `INFO` to verify
that Cluster is disabled and `maxmemory-policy` is `noeviction`; startup fails
if either property cannot be verified. Set `inspectServer: false` only for a
managed single-shard provider that denies both commands, after independently
verifying both requirements.

Use a dedicated Valkey database or pass `{ keyPrefix: '...' }` as the adapter's
second argument to isolate Flue keys. The default is `flue`; use a stable unique
prefix for each application or tenant. Changing the prefix points Flue at a
separate empty namespace and does not migrate existing data.

## What gets stored

The adapter stores canonical append-only conversation streams, disposable
snapshots, immutable external attachments, accepted direct and dispatched
submissions, recovery journals, workflow-run records and indexes, and event
streams. The canonical stream is the sole transcript; sessions have no
per-session deletion. Whole-instance stream, snapshot, and attachment deletion
methods are low-level primitives. It does not store sandbox files, external API
side effects, credentials, or application business data.

## Verify

1. Typecheck and build the configured Node target; confirm `db.ts` is discovered.
2. Point `VALKEY_URL` at a throwaway persistent standalone or managed single-shard
   Valkey deployment configured with `noeviction`.
3. Start the server and confirm migration succeeds. If inspection is disabled,
   independently verify Cluster is off and the eviction policy is `noeviction`.
4. Create state, restart the Flue server, and confirm it reloads. Test the chosen
   AOF/snapshot recovery separately; a process restart does not prove durability
   across Valkey server loss.
5. Do not use a production database for verification.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
