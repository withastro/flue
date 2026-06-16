---
title: MongoDB
description: Give Flue agents and workflow runs durable, shared state with MongoDB.
package:
  name: '@flue/mongodb'
  href: https://www.npmjs.com/package/@flue/mongodb
---

## Quickstart

Add durable, shared state to an existing Flue project with the [MongoDB](https://www.mongodb.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database mongodb
```

## Overview

The MongoDB blueprint installs `@flue/mongodb` and the official `mongodb`
driver, creates a complete `db.ts` runner in the project's source-root, and
follows the project's existing secret convention for `MONGODB_URL` and
`MONGODB_DATABASE`. The generated adapter connects the driver, selects the
database, and passes a project-owned runner to `mongodb()`:

```ts title="src/db.ts (abridged)"
import { mongodb, type MongoOperations, type MongoRunner } from '@flue/mongodb';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URL!);
await client.connect();

const db = client.db(process.env.MONGODB_DATABASE);
const runner: MongoRunner = {
  /* ... */
};

export default mongodb(runner);
```

The blueprint does not modify the MongoDB deployment, which must support
transactions. Flue discovers the adapter during a Node build
and persists agent sessions, accepted submissions, workflow runs, event
streams, and image chunks so that state survives process restarts and can be
shared across replicas. Application business data remains application-owned.

## Configure

| Variable           | Purpose                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- |
| `MONGODB_URL`      | **Required** — MongoDB connection string, including credentials and TLS options when required.                        |
| `MONGODB_DATABASE` | **Optional** — Explicit database name for Flue state; recommended when the URL does not select the intended database. |

The official driver reads these values at runtime. Never commit credentials.
For local development, `flue dev --env <file>` and `flue run --env <file>` load
any `.env`-format file; use the deployment platform's secret store in
production.

`client.db(undefined)` can select the database from the connection string (or
the driver's default), but setting `MONGODB_DATABASE` explicitly avoids an
ambiguous deployment. Prefer a dedicated database. If Flue must share one, pass
a stable unique `collectionPrefix` to `mongodb()`; changing it selects a new
namespace rather than moving existing data.

The blueprint installs `@flue/mongodb` and the official `mongodb` driver, then
writes a complete source-root `db.ts` runner. Flue discovers the file at build
time and wires the adapter into the generated Node server.

This is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite
and rejects `db.ts`, so MongoDB is not used on that target. See
[Database](/docs/guide/database/) for target-specific persistence behavior.

## Choose a supported deployment

MongoDB transactions require one of these deployments:

- MongoDB Atlas;
- a replica set;
- a transaction-capable sharded cluster; or
- a single-node replica set.

A standalone `mongod` is unsupported. Migration checks the topology before
creating collections or stamping the Flue schema version and fails when the
deployment cannot run transactions.

For local development, a single-node replica set is one MongoDB server started
with replica-set mode enabled and initialized once as a one-member set. Follow
the instructions for your existing installation or container setup; the
production requirements and operational tradeoffs remain those of a replica
set.

## Transactions and the driver runner

`@flue/mongodb` exposes a small driver seam rather than bundling a production
client. The generated `db.ts` wraps the official driver with all collection
operations, topology inspection, collection and index management, transactions,
and `close()`.

Each transaction uses one `ClientSession`, snapshot read concern, and majority
write concern. Callback operations are session-bound and serialized because the
driver does not support parallel operations inside one transaction. The runner
uses separate bounded retry loops: it reruns the full callback for
`TransientTransactionError`, while `UnknownTransactionCommitResult` retries
only `commitTransaction()`. This avoids repeating application work when only the
commit outcome is uncertain.

Keep the complete generated runner when adapting connection options. In
particular, do not replace transaction collections with database-level
collections or remove the operation queue.

## Migrations and indexes

Flue calls `migrate()` automatically at server startup. After validating the
topology, migration creates collections with strict validators and creates the
required indexes. It then inspects the actual validator, validation level and
action, plus each required index's key, uniqueness, partial filter, and
collation before writing the schema version. Incompatible definitions and data
written by a newer Flue version stop startup. There is no separate migration
command.

## Large values and staged writes

MongoDB limits a BSON document to 16 MiB. The adapter JSON-serializes arbitrary
runtime values and stages them as immutable parts bounded to 4 MiB. A short
transaction publishes the completed generation and its manifest, so large
values are never made visible partially. Abandoned staged generations and
retired values are collected later.

Images keep Flue's persisted chunk representation and use the same staged value
path. Avoid putting large runtime values directly into custom MongoDB documents;
that bypasses the adapter's BSON-limit handling.

## What gets stored

MongoDB stores session generations and messages, permanent session guards,
accepted direct and dispatched submissions, recovery journals, leases and
deletion receipts, workflow runs and indexes, persisted event streams, and image
chunks. Session-tree cleanup is fenced and may retry its idempotent external
callback after an expired lease.

The adapter does not store sandbox files, external API side effects, credentials,
or application-owned business records.

## Verify

Build the Node target and start it with `MONGODB_URL` and `MONGODB_DATABASE`
pointing at a throwaway supported deployment. Confirm migration creates the
collections and indexes, create state, restart Flue, and verify the state
reloads. Exercise a value larger than 4 MiB to cover multipart staging. A
throwaway standalone `mongod` should fail migration before the schema version is
stamped. Do not verify against a production database.
