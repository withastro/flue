# `@flue/mongodb`

MongoDB persistence for Flue Node-target projects. It requires a replica set, Atlas deployment, or transaction-capable sharded cluster; standalone MongoDB is rejected before schema stamping.

```sh
pnpm add @flue/mongodb mongodb
```

The package has no production driver dependency. Supply a `MongoRunner` backed by your configured driver. The runner must use snapshot read concern, majority write concern, one `ClientSession` for every callback operation, sequential callback operations, bounded whole-transaction retries for `TransientTransactionError`, and commit-only retries for `UnknownTransactionCommitResult`.

```ts
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
      const options = session ? { session } : {};
      return {
        findOne: (filter, opts) => queue(() => collection.findOne(filter, { ...opts, ...options })),
        find: (filter = {}, opts = {}) =>
          queue(() => collection.find(filter, { ...opts, ...options }).toArray()),
        insertOne: (document) => queue(() => collection.insertOne(document, options)),
        insertMany: (documents) => queue(() => collection.insertMany(documents, options)),
        updateOne: (filter, update, opts) =>
          queue(() => collection.updateOne(filter, update, { ...opts, ...options })),
        updateMany: (filter, update) => queue(() => collection.updateMany(filter, update, options)),
        findOneAndUpdate: (filter, update, opts) =>
          queue(() => collection.findOneAndUpdate(filter, update, { ...opts, ...options })),
        deleteOne: (filter) => queue(() => collection.deleteOne(filter, options)),
        deleteMany: (filter) => queue(() => collection.deleteMany(filter, options)),
      } as MongoCollection;
    },
  };
};

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
        for (let commitAttempt = 0; ; commitAttempt++) {
          try {
            await session.commitTransaction();
            break;
          } catch (error) {
            const retryable =
              error instanceof Error &&
              'hasErrorLabel' in error &&
              typeof error.hasErrorLabel === 'function' &&
              error.hasErrorLabel('UnknownTransactionCommitResult');
            if (!retryable || commitAttempt === 9) throw error;
          }
        }
        return result;
      } catch (error) {
        await session.abortTransaction().catch(() => undefined);
        if (
          !(error instanceof Error) ||
          !('hasErrorLabel' in error) ||
          !(error as any).hasErrorLabel('TransientTransactionError') ||
          attempt === 4
        )
          throw error;
      } finally {
        await session.endSession();
      }
    }
    throw new Error('unreachable');
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
      transactions: kind !== 'standalone' && hello.logicalSessionTimeoutMinutes != null,
    };
  },
  async ensureCollection(spec) {
    const existing = await db.listCollections({ name: spec.name }).hasNext();
    if (!existing) {
      try {
        await db.createCollection(spec.name, {
          validator: spec.validator,
          validationLevel: spec.validationLevel,
          validationAction: spec.validationAction,
        });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !('codeName' in error) ||
          error.codeName !== 'NamespaceExists'
        )
          throw error;
      }
    }
    await db.command({
      collMod: spec.name,
      validator: spec.validator,
      validationLevel: spec.validationLevel,
      validationAction: spec.validationAction,
    });
    for (const index of spec.indexes) await db.collection(spec.name).createIndex(index.key, index);
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

Keep the transaction operation wrapper session-bound and sequential; do not fall back to database-level collections inside the callback. Retry the whole callback only for `TransientTransactionError`, retry only commit for `UnknownTransactionCommitResult`, and bound both loops.

Call and await `migrate()` before `connect()`. Migration verifies exact validators and required indexes before writing the Flue schema version and rejects unsupported versions. Schema v6 is a reset boundary: clear stores created with another schema version before migrating. Flue stores canonical append-only conversation streams, disposable snapshots, immutable external attachments, durable submissions and journals, leases, workflow runs, and distinct event streams. The canonical stream is the sole transcript; sessions append for the instance lifetime and have no per-session deletion. Whole-instance stream, snapshot, and attachment deletion methods are low-level primitives, not public orchestration. Arbitrary values are staged as bounded immutable parts with durable generation state before a short transaction publishes their manifest.

Use a dedicated database when possible. Otherwise set `collectionPrefix` to a unique namespace. Configure credentials, TLS, pooling, backups, and client lifecycle in the application-owned driver.
