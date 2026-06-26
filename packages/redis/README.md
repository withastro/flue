# `@flue/redis`

Persistent Redis and Valkey storage for Flue applications on the Node.js target.
The package is driver-free at runtime and accepts a small Redis-native runner.

```ts
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.REDIS_URL });
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

Default-export the adapter from a source-root `db.ts`. Flue calls `migrate()` at
startup, verifies the deployment when `CONFIG` or `INFO` inspection is allowed,
and records the runtime schema version. Set `inspectServer: false` only when a
managed provider denies both inspection commands and you have independently
verified the requirements below.

## Deployment requirements

Use persistent Redis or Valkey with `maxmemory-policy noeviction`. Enable durable
persistence appropriate for your recovery objective, normally AOF with an
explicit fsync policy and/or durable snapshots. Cache-only deployments can lose
accepted work and are unsupported.

The initial release supports standalone servers and managed single-shard
endpoints. Redis Cluster is unsupported. Flue keys intentionally use base64url
segments and span independent atomic operations; they are not a cluster hash-slot
schema.

Use a dedicated database or configure `keyPrefix` to isolate Flue data. The
prefix defaults to `flue`. Tests and multi-tenant deployments should use a random
or otherwise unique prefix. Production cleanup uses maintained sets and sorted
sets; it never scans the keyspace.

## Storage model

The adapter persists the canonical append-only conversation stream, disposable
snapshots, immutable external attachments, submission lifecycle state, workflow
runs, and distinct event streams. The canonical stream is the sole transcript;
sessions append for the instance lifetime and have no per-session deletion.
Whole-instance stream, snapshot, and attachment deletion methods are low-level
primitives, not public orchestration.

Hashes hold authoritative metadata and immutable generation manifests. Sorted
sets maintain submission, run, and event ordering; sets maintain bounded cleanup
ownership. Lua scripts serialize admission, claims, lifecycle and lease
transitions, journals, run indexes, and event append/close.

Direct-submission payloads and image chunks are staged into immutable generation
hashes with ordinary or pipelined commands, then published atomically during
admission. Readers bind to one published generation, so they never observe a
partially written value. Reader counts and a grace period protect generations held
by concurrent loads. Per-submission sorted sets reclaim superseded and failed
staging without `KEYS` scans; reclamation is opportunistic on later submission
activity, so abandoned staging can remain until that submission is accessed again.
Stream segment insertion uses single-key `HSETNX` first-writer-wins semantics.

Redis Lua does not roll back earlier commands when a later command fails. Scripts
validate key types first, allocate index capacity before authoritative state where
possible, and normal operations repair indexes from authoritative hashes. With
`noeviction`, this substantially limits partial transitions, but Redis running out
of memory during a multi-command script can still require operational recovery.
Maintain enough headroom for the largest staged generation and its transition
indexes; `noeviction` prevents data loss but does not make an exhausted server
writable.

## Bring your own driver

The runner exposes:

- `command(command, args)` for normalized Redis commands;
- `eval(script, keys, args)` with keys and arguments kept separate;
- optional `pipeline(commands)` for staging large immutable generations;
- `close()` for the client lifecycle.

A pipeline must return exactly one result per command and reject if any command
failed. For ioredis, inspect each `[error, result]` tuple from `pipeline.exec()`
and throw the first non-null error before returning the result values. The
adapter also validates result count and common error-result shapes, but the
runner remains responsible for normalizing driver-specific failures.

`@flue/redis` does not bundle a production client. You own credentials, TLS,
timeouts, reconnect behavior, and topology. Supply connection strings through
your secret system and never commit credentials.

## Target support

This adapter targets Node.js only. Cloudflare projects use Durable Object SQLite
and reject project-owned `db.ts` adapters.

## Installation

```sh
pnpm add @flue/redis redis
```

The `redis` package above is one possible application driver. It is only a
development dependency of `@flue/redis` and is not included in its runtime
artifact.
