---
{ "kind": "database", "version": 1, "website": "https://www.mongodb.com" }
---

# Add MongoDB to Flue

You are an AI coding agent configuring MongoDB-backed persistence for a Flue
project using the first-party `@flue/mongodb` adapter and the official `mongodb`
driver.

This stores canonical agent conversation streams, disposable snapshots,
immutable attachments, accepted submissions, workflow runs, and event streams.
It does not store application business data.

## Check the target and deployment

A `db.ts` adapter is a **Node-target** concern. The Cloudflare target uses
Durable Object SQLite automatically and rejects `db.ts` at build time. If this
project targets Cloudflare, stop and tell the user — there is nothing to add.

MongoDB must be Atlas, a replica set, a transaction-capable sharded cluster, or
a single-node replica set. A standalone `mongod` is unsupported. Migration
checks topology before creating collections or stamping the Flue schema version
and fails when transactions are unavailable.

For local development, a single-node replica set means starting one `mongod`
with replica-set mode enabled and initializing that set once. Keep this
conceptual: use the installation or container tooling already chosen by the
project rather than adding host-specific deployment instructions.

## Inspect the project

Read local instructions (`AGENTS.md` and similar), detect the package manager,
and select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Check for an existing `db.ts`; if one is present, confirm with
the user before replacing it. Inspect the project's secret conventions.

Install `@flue/mongodb` and the official `mongodb@^6.17.0` driver with the project's
package manager. The adapter does not bundle a production driver; the project
owns credentials, TLS, pooling, timeouts, and client lifecycle.

## Create `db.ts`

Write `<source-dir>/db.ts` with this complete runner. Keep every operation in a
transaction bound to its `ClientSession` and serialized through the operation
queue. Whole transactions and commit uncertainty use separate bounded retries.

```ts title="src/db.ts"
// flue-blueprint: database/mongodb@1
import {
  mongodb,
  type MongoCollection,
  type MongoOperations,
  type MongoRunner,
} from '@flue/mongodb';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URL!);
await client.connect();
const db = client.db(process.env.MONGODB_DATABASE);

const operations = (session?: import('mongodb').ClientSession): MongoOperations => {
  let pending = Promise.resolve();
  const queue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = pending.then(operation, operation);
    pending = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return {
    collection(name): MongoCollection {
      const collection = db.collection(name);
      const sessionOptions = session ? { session } : {};
      return {
        findOne: (filter, options) =>
          queue(() => collection.findOne(filter, { ...options, ...sessionOptions })),
        find: (filter = {}, options = {}) =>
          queue(() => collection.find(filter, { ...options, ...sessionOptions }).toArray()),
        insertOne: (document) => queue(() => collection.insertOne(document, sessionOptions)),
        insertMany: (documents) => queue(() => collection.insertMany(documents, sessionOptions)),
        updateOne: (filter, update, options) =>
          queue(() => collection.updateOne(filter, update, { ...options, ...sessionOptions })),
        updateMany: (filter, update) =>
          queue(() => collection.updateMany(filter, update, sessionOptions)),
        findOneAndUpdate: (filter, update, options) =>
          queue(() =>
            collection.findOneAndUpdate(filter, update, { ...options, ...sessionOptions }),
          ),
        deleteOne: (filter) => queue(() => collection.deleteOne(filter, sessionOptions)),
        deleteMany: (filter) => queue(() => collection.deleteMany(filter, sessionOptions)),
      } as MongoCollection;
    },
  };
};

const hasErrorLabel = (error: unknown, label: string): boolean =>
  error !== null &&
  typeof error === 'object' &&
  'hasErrorLabel' in error &&
  typeof error.hasErrorLabel === 'function' &&
  error.hasErrorLabel(label);

const runner: MongoRunner = {
  ...operations(),
  async transaction(fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const session = client.startSession();
      try {
        session.startTransaction({
          readConcern: { level: 'snapshot' },
          writeConcern: { w: 'majority' },
        });
        const result = await fn(operations(session));
        for (let commitAttempt = 0; commitAttempt < 10; commitAttempt++) {
          try {
            await session.commitTransaction();
            return result;
          } catch (error) {
            if (!hasErrorLabel(error, 'UnknownTransactionCommitResult') || commitAttempt === 9) {
              throw error;
            }
          }
        }
      } catch (error) {
        await session.abortTransaction().catch(() => undefined);
        if (!hasErrorLabel(error, 'TransientTransactionError') || attempt === 4) {
          throw error;
        }
      } finally {
        await session.endSession();
      }
    }
    throw new TypeError('MongoDB transaction retry limit exhausted.');
  },
  async topology() {
    const hello = await db.admin().command({ hello: 1 });
    const kind = hello.setName
      ? 'replica_set'
      : hello.msg === 'isdbgrid'
        ? 'sharded'
        : 'standalone';
    return {
      kind,
      transactions:
        (kind === 'replica_set' || kind === 'sharded') &&
        hello.logicalSessionTimeoutMinutes != null,
    };
  },
  async ensureCollection(spec) {
    if (!(await db.listCollections({ name: spec.name }).hasNext())) {
      try {
        await db.createCollection(spec.name, {
          validator: spec.validator,
          validationLevel: spec.validationLevel,
          validationAction: spec.validationAction,
        });
      } catch (error) {
        if (
          error === null ||
          typeof error !== 'object' ||
          !('codeName' in error) ||
          error.codeName !== 'NamespaceExists'
        ) {
          throw error;
        }
      }
    }
    await db.command({
      collMod: spec.name,
      validator: spec.validator,
      validationLevel: spec.validationLevel,
      validationAction: spec.validationAction,
    });
    for (const { key, ...options } of spec.indexes) {
      await db.collection(spec.name).createIndex(key, options);
    }
  },
  async inspectCollection(name) {
    const info = await db.listCollections({ name }).next();
    if (!info) return null;
    const indexes = (await db.collection(name).listIndexes().toArray())
      .filter((index) => index.name !== '_id_')
      .map((index) => ({
        name: String(index.name),
        key: index.key as Record<string, 1 | -1>,
        ...(index.unique === true ? { unique: true } : {}),
        ...(index.partialFilterExpression
          ? { partialFilterExpression: index.partialFilterExpression }
          : {}),
        ...(index.collation ? { collation: index.collation } : {}),
      }));
    return {
      validator: info.options.validator,
      validationLevel: info.options.validationLevel,
      validationAction: info.options.validationAction,
      indexes,
    };
  },
  close: () => client.close(),
};

export default mongodb(runner);
```

Do not use database-level collections in the transaction callback. Do not run
callback operations concurrently: MongoDB transactions do not support parallel
operations on one session. Retry the whole callback only for
`TransientTransactionError`; retry only `commitTransaction()` for
`UnknownTransactionCommitResult`; keep both loops bounded.

## Configure the database

Set `MONGODB_URL` to the deployment connection string. Set `MONGODB_DATABASE`
to a dedicated database name when the URL does not select one, or when the
application should override the URL's database. `client.db(undefined)` uses the
driver's database selection from the URL (and otherwise its driver default), so
an explicit `MONGODB_DATABASE` is recommended.

Never commit credentials. For local development, `flue dev --env <file>` and
`flue run --env <file>` load any `.env`-format file. In production, use the
platform's secret store. A dedicated database is preferred; otherwise pass a
stable unique `collectionPrefix` as the second argument to `mongodb()`. Changing
the prefix selects a separate namespace and does not migrate existing data.

## Migrations and indexes

Flue discovers `db.ts` and runs `migrate()` at server startup. Migration first
rejects unsupported topology, then creates or updates collections with strict
validators and required indexes. It inspects the actual collection validator,
validation settings, index keys, uniqueness, partial filters, and collations
before stamping the schema version. A database written by a newer Flue version
is rejected. There is no separate migration command.

## Values and stored state

MongoDB's BSON document limit is 16 MiB. The adapter JSON-serializes arbitrary
values and stages them as immutable parts bounded to 4 MiB before a short
transaction publishes a manifest. Failed or abandoned staged generations are
cleaned up later. Do not bypass this path by embedding large runtime values in
custom collection documents.

The adapter stores canonical conversation streams, disposable snapshots,
immutable external attachments, durable submissions and recovery journals,
workflow runs and indexes, and event streams. The canonical stream is the sole
transcript; sessions append for the agent-instance lifetime, with no per-session
deletion. Whole-instance stream, snapshot, and attachment deletion methods are
low-level primitives, not a promise of public orchestration. It does not store
sandbox files, external API effects, credentials, or application business data.

## Verify

1. Typecheck and build the configured Node target; confirm `db.ts` is discovered.
2. Point `MONGODB_URL` and `MONGODB_DATABASE` at a throwaway Atlas database,
   replica set, transaction-capable sharded cluster, or single-node replica set.
3. Start the server and confirm migration creates collections and indexes. Then
   restart it and confirm stored state reloads.
4. Point at a throwaway standalone `mongod` and confirm migration fails before a
   schema-version document is written.
5. Exercise a value larger than one 4 MiB part and confirm it round-trips.
6. Do not use a production database for verification.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in the primary marked file.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.
