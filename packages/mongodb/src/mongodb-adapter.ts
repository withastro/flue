import { randomUUID } from 'node:crypto';
import type { PersistenceAdapter } from '@flue/runtime/adapter';
import { assertSupportedFlueSchemaVersion, FLUE_SCHEMA_VERSION } from '@flue/runtime/adapter';
import {
	MongoConversationSnapshotStore,
	MongoConversationStreamStore,
} from './conversation-store.ts';
import { MongoEventStreamStore } from './event-stream-store.ts';
import type { MongoOptions, MongoRunner } from './mongodb-runner.ts';
import { MongoRunStore } from './run-store.ts';
import { collectionName, ensureSchema, schema } from './schema.ts';
import { MongoSessionStore } from './session-store.ts';
import { MongoSubmissionStore } from './submission-store.ts';
import { ValueStore } from './value-store.ts';

const MIGRATION_LEASE_MS = 30_000;

export function mongodb(runner: MongoRunner, options: MongoOptions = {}): PersistenceAdapter {
	const prefix = options.collectionPrefix ?? 'flue_';
	let closed = false;
	let migrated = false;
	return {
		async migrate() {
			migrated = false;
			const meta = runner.collection(collectionName(prefix, 'meta'));
			const existingVersion = await meta.findOne({ _id: 'schema_version' });
			if (existingVersion) assertMigratableSchemaVersion(String(existingVersion.value));
			const topology = await runner.topology();
			if (topology.kind === 'standalone' || !topology.transactions)
				throw new TypeError(
					'@flue/mongodb requires a replica set, Atlas, or a transaction-capable sharded cluster.',
				);
			const metaSpec = schema(prefix)[0];
			if (!metaSpec) throw new TypeError('MongoDB schema is missing metadata collection.');
			await runner.ensureCollection(metaSpec);
			const ownerId = randomUUID();
			while (true) {
				const now = Date.now();
				const lock = await meta
					.findOneAndUpdate(
						{
							_id: 'migration_lock',
							$or: [
								{ ownerId },
								{ leaseExpiresAt: { $lt: now } },
								{ leaseExpiresAt: { $exists: false } },
							],
						},
						{ $set: { ownerId, leaseExpiresAt: now + MIGRATION_LEASE_MS } },
						{ upsert: true, returnDocument: 'after' },
					)
					.catch((error) => (isDuplicate(error) ? null : Promise.reject(error)));
				if (lock?.ownerId === ownerId) break;
				await new Promise((resolve) => setTimeout(resolve, 50));
			}
			let lockLost = false;
			let renewal = Promise.resolve();
			const heartbeat = setInterval(() => {
				renewal = renewal.then(async () => {
					const result = await meta
						.updateOne(
							{ _id: 'migration_lock', ownerId },
							{ $set: { leaseExpiresAt: Date.now() + MIGRATION_LEASE_MS } },
						)
						.catch(() => null);
					if (!result || result.matchedCount !== 1) lockLost = true;
				});
			}, MIGRATION_LEASE_MS / 3);
			try {
				const lockedVersion = await meta.findOne({ _id: 'schema_version' });
				if (lockedVersion) assertMigratableSchemaVersion(String(lockedVersion.value));
				await ensureSchema(runner, prefix);
				await renewal;
				if (lockLost || !(await meta.findOne({ _id: 'migration_lock', ownerId })))
					throw new TypeError('MongoDB migration lock ownership was lost.');
				const verifiedVersion = await meta.findOne({ _id: 'schema_version' });
				if (verifiedVersion) assertMigratableSchemaVersion(String(verifiedVersion.value));
				else await meta.insertOne({ _id: 'schema_version', value: FLUE_SCHEMA_VERSION });
				await new ValueStore(runner, prefix).collectGarbage();
				migrated = true;
			} finally {
				clearInterval(heartbeat);
				await renewal;
				await meta.deleteOne({ _id: 'migration_lock', ownerId });
			}
		},
		connect() {
			if (!migrated)
				throw new TypeError('@flue/mongodb connect() requires a successful migrate() first.');
			return {
				executionStore: {
					sessions: new MongoSessionStore(runner, prefix),
					submissions: new MongoSubmissionStore(runner, prefix),
				},
				runStore: new MongoRunStore(runner, prefix),
				eventStreamStore: new MongoEventStreamStore(runner, prefix),
				conversationStreamStore: new MongoConversationStreamStore(runner, prefix),
				conversationSnapshotStore: new MongoConversationSnapshotStore(runner, prefix),
			};
		},
		async close() {
			if (!closed) {
				closed = true;
				await runner.close();
			}
		},
	};
}

function assertMigratableSchemaVersion(storedVersion: string): void {
	assertSupportedFlueSchemaVersion(storedVersion);
}

function isDuplicate(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { code: unknown }).code === 11000,
	);
}
