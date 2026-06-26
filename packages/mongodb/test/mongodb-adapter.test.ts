import { randomUUID } from 'node:crypto';
import { PersistedSchemaVersionError } from '@flue/runtime/adapter';
import {
	defineConversationStreamStoreContractTests,
	defineEventStreamStoreContractTests,
	defineRunStoreContractTests,
	defineStoreContractTests,
} from '@flue/runtime/test-utils';
import {
	type ClientSession,
	type Collection,
	type Db,
	MongoClient,
	MongoServerError,
} from 'mongodb';
import { describe, expect, it } from 'vitest';
import {
	type MongoCollection,
	type MongoCollectionSpec,
	type MongoOperations,
	type MongoRunner,
	mongodb,
} from '../src/index.ts';

try {
	process.loadEnvFile('../../.env');
} catch {}
const url = process.env.TEST_MONGODB_URL;
let topologySupported = false;
if (url) {
	const probe = new MongoClient(url, { serverSelectionTimeoutMS: 10_000 });
	try {
		await probe.connect();
		const hello = await probe.db('admin').command({ hello: 1 });
		topologySupported = Boolean(
			(hello.setName || hello.msg === 'isdbgrid') && hello.logicalSessionTimeoutMinutes != null,
		);
	} catch {
	} finally {
		await probe.close();
	}
}
const describeMongo = url && topologySupported ? describe : describe.skip;

function result(value: {
	acknowledged: boolean;
	matchedCount?: number;
	modifiedCount?: number;
	deletedCount?: number;
	upsertedId?: unknown;
}) {
	return value;
}
function collectionAdapter(
	collection: Collection,
	queue: <T>(operation: () => Promise<T>) => Promise<T>,
	session?: ClientSession,
): MongoCollection {
	const options = session ? { session } : {};
	return {
		findOne: (filter, opts) =>
			queue(() => collection.findOne(filter, { ...opts, ...options })) as Promise<Record<
				string,
				unknown
			> | null>,
		find: (filter = {}, opts = {}) =>
			queue(() => collection.find(filter, { ...opts, ...options }).toArray()) as Promise<
				Record<string, unknown>[]
			>,
		insertOne: async (document) =>
			result(await queue(() => collection.insertOne(document, options))),
		insertMany: async (documents) =>
			result(await queue(() => collection.insertMany(documents, options))),
		updateOne: async (filter, update, opts) =>
			result(await queue(() => collection.updateOne(filter, update, { ...opts, ...options }))),
		updateMany: async (filter, update) =>
			result(await queue(() => collection.updateMany(filter, update, options))),
		findOneAndUpdate: (filter, update, opts) =>
			queue(() =>
				collection.findOneAndUpdate(filter, update, { ...opts, ...options }),
			) as Promise<Record<string, unknown> | null>,
		deleteOne: async (filter) => result(await queue(() => collection.deleteOne(filter, options))),
		deleteMany: async (filter) => result(await queue(() => collection.deleteMany(filter, options))),
	};
}

function createRunner(client: MongoClient, db: Db): MongoRunner {
	const operations = (session?: ClientSession): MongoOperations => {
		let pending = Promise.resolve();
		const queue = <T>(operation: () => Promise<T>): Promise<T> => {
			const next = pending.then(operation, operation);
			pending = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		};
		return { collection: (name) => collectionAdapter(db.collection(name), queue, session) };
	};
	return {
		...operations(),
		async transaction(fn) {
			for (let attempt = 0; attempt < 5; attempt++) {
				const session = client.startSession();
				try {
					session.startTransaction({
						readConcern: { level: 'snapshot' },
						writeConcern: { w: 'majority' },
					});
					const value = await fn(operations(session));
					for (let commits = 0; ; commits++) {
						try {
							await session.commitTransaction();
							break;
						} catch (error) {
							if (
								!(error instanceof MongoServerError) ||
								!error.hasErrorLabel('UnknownTransactionCommitResult') ||
								commits === 9
							)
								throw error;
						}
					}
					return value;
				} catch (error) {
					await session.abortTransaction().catch(() => undefined);
					if (
						!(error instanceof MongoServerError) ||
						!error.hasErrorLabel('TransientTransactionError') ||
						attempt === 4
					)
						throw error;
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
				transactions: kind !== 'standalone' && hello.logicalSessionTimeoutMinutes != null,
			};
		},
		async ensureCollection(spec: MongoCollectionSpec) {
			if (!(await db.listCollections({ name: spec.name }).hasNext())) {
				try {
					await db.createCollection(spec.name, {
						validator: spec.validator,
						validationLevel: spec.validationLevel,
						validationAction: spec.validationAction,
					});
				} catch (error) {
					if (!(error instanceof MongoServerError) || error.codeName !== 'NamespaceExists')
						throw error;
				}
			}
			await db.command({
				collMod: spec.name,
				validator: spec.validator,
				validationLevel: spec.validationLevel,
				validationAction: spec.validationAction,
			});
			for (const index of spec.indexes)
				await db.collection(spec.name).createIndex(index.key, index);
		},
		async inspectCollection(name) {
			const info = await db.listCollections({ name }).next();
			if (!info) return null;
			const indexes = (await db.collection(name).listIndexes().toArray())
				.filter((index) => index.name !== '_id_')
				.map((index) => ({
					name: String(index.name),
					key: index.key as Record<string, 1 | -1>,
					...(index.unique ? { unique: true } : {}),
					...(index.partialFilterExpression
						? { partialFilterExpression: index.partialFilterExpression }
						: {}),
					...(index.collation?.locale === 'simple'
						? { collation: { locale: 'simple' as const } }
						: {}),
				}));
			return {
				validator:
					'options' in info && info.options?.validator
						? (info.options.validator as Record<string, unknown>)
						: {},
				validationLevel: 'strict',
				validationAction: 'error',
				indexes,
			};
		},
		close: () => client.close(),
	};
}

interface Harness {
	client: MongoClient;
	db: Db;
	adapter: ReturnType<typeof mongodb>;
}
let harness: Harness | undefined;
async function createHarness(): Promise<Harness> {
	if (!url) throw new TypeError('TEST_MONGODB_URL is required.');
	const client = new MongoClient(url);
	await client.connect();
	const db = client.db(`flue_test_${randomUUID().replaceAll('-', '')}`);
	const adapter = mongodb(createRunner(client, db));
	await adapter.migrate?.();
	return { client, db, adapter };
}
async function stores() {
	harness = await createHarness();
	return harness.adapter.connect();
}
async function cleanup() {
	if (!harness) return;
	await harness.db.dropDatabase();
	await harness.adapter.close?.();
	harness = undefined;
}

describeMongo('MongoDB shared contracts', () => {
	defineStoreContractTests('MongoDB AgentExecutionStore', {
		async create() {
			return (await stores()).executionStore;
		},
		cleanup,
	});
	defineRunStoreContractTests('MongoDB RunStore', {
		async create() {
			return (await stores()).runStore;
		},
		cleanup,
	});
	defineEventStreamStoreContractTests('MongoDB EventStreamStore', {
		async create() {
			return (await stores()).eventStreamStore;
		},
		cleanup,
	});
	defineConversationStreamStoreContractTests('MongoDB ConversationStreamStore', {
		async create() {
			const connected = await stores();
			if (!connected.conversationStreamStore || !connected.conversationSnapshotStore) {
				throw new Error('Expected MongoDB conversation stores.');
			}
			return {
				stream: connected.conversationStreamStore,
				snapshots: connected.conversationSnapshotStore,
				executionStore: connected.executionStore,
			};
		},
		cleanup,
	});
});

describeMongo('mongodb() integration', () => {
	it('allows one claim when independent clients race', async () => {
		if (!url) throw new TypeError('TEST_MONGODB_URL is required.');
		const first = await createHarness();
		const secondClient = new MongoClient(url);
		await secondClient.connect();
		const second = mongodb(createRunner(secondClient, first.db));
		const a = (await first.adapter.connect()).executionStore.submissions;
		const b = (await second.connect()).executionStore.submissions;
		await a.admitDispatch({
			dispatchId: 'd',
			agent: 'a',
			id: 'i',
			input: {},
			acceptedAt: new Date().toISOString(),
		});
		const claims = await Promise.all([
			a.claimSubmission({
				submissionId: 'd',
				attemptId: 'a',
				ownerId: 'a',
				leaseExpiresAt: Date.now() + 10_000,
			}),
			b.claimSubmission({
				submissionId: 'd',
				attemptId: 'b',
				ownerId: 'b',
				leaseExpiresAt: Date.now() + 10_000,
			}),
		]);
		expect(claims.filter(Boolean)).toHaveLength(1);
		await first.db.dropDatabase();
		await first.adapter.close?.();
		await second.close?.();
	});
	it('orders concurrent event appends and rejects append after close', async () => {
		const value = await stores();
		await value.eventStreamStore.createStream('x');
		const offsets = await Promise.all(
			Array.from({ length: 10 }, (_, index) => value.eventStreamStore.appendEvent('x', { index })),
		);
		expect(new Set(offsets).size).toBe(10);
		await value.eventStreamStore.closeStream('x');
		await expect(value.eventStreamStore.appendEvent('x', {})).rejects.toThrow();
		await cleanup();
	});
	it('rejects schema version 2 without migrating it', async () => {
		const value = await stores();
		void value;
		if (!harness) throw new TypeError('Harness is required.');
		await harness.db
			.collection<{ _id: string; value: number }>('flue_meta')
			.updateOne({ _id: 'schema_version' }, { $set: { value: 2 } });
		await expect(harness.adapter.migrate?.()).rejects.toThrow(PersistedSchemaVersionError);
		expect(
			await harness.db
				.collection<{ _id: string; value: number }>('flue_meta')
				.findOne({ _id: 'schema_version' }),
		).toMatchObject({ value: 2 });
		await cleanup();
	});
	it('rejects a newer schema version', async () => {
		const value = await stores();
		void value;
		if (!harness) throw new TypeError('Harness is required.');
		await harness.db
			.collection<{ _id: string; value: number }>('flue_meta')
			.updateOne({ _id: 'schema_version' }, { $set: { value: 999 } });
		await expect(harness.adapter.migrate?.()).rejects.toThrow(PersistedSchemaVersionError);
		await cleanup();
	});
	it('keeps the first run when independent clients create it concurrently', async () => {
		if (!url) throw new TypeError('TEST_MONGODB_URL is required.');
		const first = await createHarness();
		const secondClient = new MongoClient(url);
		await secondClient.connect();
		const second = mongodb(createRunner(secondClient, first.db));
		await second.migrate?.();
		const a = (await first.adapter.connect()).runStore;
		const b = (await second.connect()).runStore;
		await expect(
			Promise.all([
				a.createRun({
					runId: 'run',
					workflowName: 'first',
					startedAt: '2026-01-01T00:00:00.000Z',
					input: { source: 'first' },
				}),
				b.createRun({
					runId: 'run',
					workflowName: 'second',
					startedAt: '2026-01-02T00:00:00.000Z',
					input: { source: 'second' },
				}),
			]),
		).resolves.toEqual([undefined, undefined]);
		const run = await a.getRun('run');
		expect(run?.workflowName === 'first' || run?.workflowName === 'second').toBe(true);
		expect(run?.input).toEqual({ source: run?.workflowName });
		await first.db.dropDatabase();
		await first.adapter.close?.();
		await second.close?.();
	});
	it('round trips an arbitrary value larger than 16 MiB', async () => {
		const value = await stores();
		const body = 'x'.repeat(17 * 1024 * 1024);
		await value.runStore.createRun({
			runId: 'large',
			workflowName: 'w',
			startedAt: new Date().toISOString(),
			input: { body },
		});
		expect((await value.runStore.getRun('large'))?.input).toEqual({ body });
		await cleanup();
	});
});

describe('mongodb() topology', () => {
	it('rejects a standalone before stamping', async () => {
		const runner = {
			topology: async () => ({ kind: 'standalone' as const, transactions: false }),
			collection: () => ({
				findOne: async () => null,
				find: async () => [],
				insertOne: async () => ({ acknowledged: true }),
				insertMany: async () => ({ acknowledged: true }),
				updateOne: async () => ({ acknowledged: true }),
				updateMany: async () => ({ acknowledged: true }),
				findOneAndUpdate: async () => null,
				deleteOne: async () => ({ acknowledged: true }),
				deleteMany: async () => ({ acknowledged: true }),
			}),
			transaction: async <T>() => null as T,
			ensureCollection: async () => {},
			inspectCollection: async () => null,
			close: () => {},
		} satisfies MongoRunner;
		await expect(mongodb(runner).migrate?.()).rejects.toThrow('replica set');
	});
});
