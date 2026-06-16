---
title: Valkey
description: Give Flue agents and workflow runs durable, shared state with Valkey.
package:
  name: '@flue/redis'
  href: https://www.npmjs.com/package/@flue/redis
---

## Quickstart

Add durable, shared state to an existing Flue project with the [Valkey](https://valkey.io) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database valkey
```

## Overview

The Valkey blueprint installs `@flue/redis` and the official Redis `redis`
client, creates a `db.ts` in the project's source-root, and follows the
project's existing secret convention for `VALKEY_URL`. It does not modify
deployment configuration because persistence and recovery settings remain
owned by the Valkey deployment.

The primary generated adapter connects the client and translates Flue database
operations into Redis-protocol commands supported by Valkey:

```ts title="src/db.ts (abridged)"
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.VALKEY_URL });
await client.connect();

export default redis({
  command: (command, args = []) => client.sendCommand([command, ...args.map(String)]),
  eval: (script, keys, args = []) => client.eval(script, { keys, arguments: args.map(String) }),
  close: () => client.close(),
});
```

This abridged excerpt omits the generated pipeline helper, which batches
commands and rejects any `Error` result. Flue discovers the adapter during a
Node build, checks and migrates its Valkey namespace at server startup, and
persists agent sessions, accepted submissions, workflow runs, and event streams
so that they survive Flue process restarts. Durability across Valkey server loss
depends on the deployment's AOF or snapshot configuration.

## Configure

| Variable     | Purpose                                                                                      |
| ------------ | -------------------------------------------------------------------------------------------- |
| `VALKEY_URL` | **Required** — Connection URL for a persistent standalone or single-shard Valkey deployment. |

The blueprint installs `@flue/redis` and the official Redis `redis`
(node-redis) client, then writes a source-root `db.ts`. Valkey implements the
Redis protocol and commands this adapter uses. This support is specific to
Valkey and does not imply that every Redis-compatible provider is supported.

This is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite
and rejects `db.ts`.

Set `VALKEY_URL` to a persistent standalone Valkey server or managed
single-shard endpoint. Valkey Cluster and cache-only configurations are
unsupported. Configure `maxmemory-policy noeviction`, plus AOF with an explicit
fsync policy and/or durable snapshots appropriate to your recovery objective.
`noeviction` avoids silent eviction; it does not make acknowledged writes
durable across server loss.

The canonical runner uses node-redis over Valkey's Redis protocol:

```ts title="src/db.ts"
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
    for (const { command, args = [] } of commands) multi.addCommand([command, ...args.map(String)]);
    const results = await multi.exec();
    for (const result of results) if (result instanceof Error) throw result;
    return results;
  },
  close: () => client.close(),
});
```

## Inspection and isolation

At startup, `inspectServer` uses `CONFIG GET`, falling back to `INFO`, to verify
that Cluster is disabled and the eviction policy is `noeviction`. Startup fails
when either requirement cannot be verified. Set `inspectServer: false` only when
a managed single-shard provider denies both commands and you have independently
verified the configuration.

Use a dedicated Valkey database or pass a stable, unique `keyPrefix` as the
adapter's second argument. The default is `flue`. Changing it selects a separate
namespace; it does not move existing keys.

## Migrations and stored data

Flue runs `migrate()` at startup. It initializes schema-version metadata
idempotently and refuses data from an unsupported newer schema; there is no
separate migration command.

Valkey stores session messages and compaction state, accepted prompts and
dispatches, recovery journals, workflow runs and indexes, and persisted event
streams. It does not store sandbox files, external API side effects, secrets, or
application business data.

## Verify durability

Build the Node target, start it against a throwaway correctly configured Valkey,
create state, restart Flue, and confirm the state reloads. Separately test the
chosen AOF or snapshot recovery procedure: restarting Flue does not prove that
Valkey survives server loss.
