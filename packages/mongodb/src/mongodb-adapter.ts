import type { PersistenceAdapter } from '@flue/runtime/adapter';
import {
	assertSupportedFlueFormatVersion,
	FLUE_FORMAT_VERSION,
	PersistedFormatVersionError,
} from '@flue/runtime/adapter';
import { ulid } from 'ulidx';
import { MongoAttachmentStore } from './attachment-store.ts';
import { MongoConversationStreamStore } from './conversation-store.ts';
import type { MongoOptions, MongoRunner } from './mongodb-runner.ts';
import { collectionName, ensureSchema, schema } from './schema.ts';
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
			// Advisory pre-lock check (fail fast before topology inspection);
			// the authoritative check and any adoption happen under the lock.
			const existingVersion = await meta.findOne({ _id: 'format_version' });
			if (existingVersion) assertSupportedFlueFormatVersion(String(existingVersion.value));
			else {
				const legacyVersion = await meta.findOne({ _id: 'schema_version' });
				if (legacyVersion) assertAdoptableLegacyVersion(String(legacyVersion.value));
				else if (await hasUnversionedData(runner, prefix)) rejectUnversionedSchema();
			}
			const topology = await runner.topology();
			if (topology.kind === 'standalone' || !topology.transactions)
				throw new TypeError(
					'@flue/mongodb requires a replica set, Atlas, or a transaction-capable sharded cluster.',
				);
			const metaSpec = schema(prefix)[0];
			if (!metaSpec) throw new TypeError('MongoDB schema is missing metadata collection.');
			await runner.ensureCollection(metaSpec);
			const ownerId = `owner_${ulid()}`;
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
					if (result?.matchedCount !== 1) lockLost = true;
				});
			}, MIGRATION_LEASE_MS / 3);
			try {
				const lockedVersion = await meta.findOne({ _id: 'format_version' });
				if (lockedVersion) assertSupportedFlueFormatVersion(String(lockedVersion.value));
				else {
					const legacyVersion = await meta.findOne({ _id: 'schema_version' });
					if (legacyVersion) {
						assertAdoptableLegacyVersion(String(legacyVersion.value));
						// The new stamp lands before the old one is removed, so
						// an interruption never leaves the store stampless.
						await meta.insertOne({ _id: 'format_version', value: FLUE_FORMAT_VERSION });
						await meta.deleteOne({ _id: 'schema_version' });
					} else if (await hasUnversionedData(runner, prefix)) rejectUnversionedSchema();
				}
				await ensureSchema(runner, prefix);
				await renewal;
				if (lockLost || !(await meta.findOne({ _id: 'migration_lock', ownerId })))
					throw new TypeError('MongoDB migration lock ownership was lost.');
				const verifiedVersion = await meta.findOne({ _id: 'format_version' });
				if (verifiedVersion) assertSupportedFlueFormatVersion(String(verifiedVersion.value));
				else await meta.insertOne({ _id: 'format_version', value: FLUE_FORMAT_VERSION });
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
				submissionStore: new MongoSubmissionStore(runner, prefix),
				conversationStreamStore: new MongoConversationStreamStore(runner, prefix),
				attachmentStore: new MongoAttachmentStore(runner, prefix),
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

/**
 * Nightly-era stores stamped `schema_version` 8 hold storage shapes
 * byte-for-byte identical to format 1, so adoption is a pure relabel of the
 * stamp — no data rewrite. Any other value at the old key names a store this
 * runtime cannot read.
 */
function assertAdoptableLegacyVersion(storedVersion: string): void {
	if (storedVersion === '8') return;
	throw new PersistedFormatVersionError({
		storedVersion,
		supportedVersion: FLUE_FORMAT_VERSION,
	});
}

async function hasUnversionedData(runner: MongoRunner, prefix: string): Promise<boolean> {
	for (const spec of schema(prefix)) {
		const document = await runner
			.collection(spec.name)
			.findOne(
				spec.name === collectionName(prefix, 'meta')
					? { _id: { $nin: ['format_version', 'schema_version', 'migration_lock'] } }
					: {},
			);
		if (document) return true;
	}
	return false;
}

function rejectUnversionedSchema(): never {
	throw new PersistedFormatVersionError({
		storedVersion: 'unversioned',
		supportedVersion: FLUE_FORMAT_VERSION,
	});
}

function isDuplicate(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { code: unknown }).code === 11000,
	);
}
