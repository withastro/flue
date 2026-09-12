import { defineConversationStreamStoreContractTests } from '@flue/runtime/test-utils/conversation-stream';
import { type ClientSession, MongoClient } from 'mongodb';
import { describe } from 'vitest';
import { mongodb } from './mongodb-adapter.ts';
import {
	type MongoDocument,
	type MongoOperations,
	type MongoRunner,
	runMongoTransactionWithRetry,
} from './mongodb-runner.ts';

const url = process.env.FLUE_TEST_MONGODB_URL;
const clients: MongoClient[] = [];
let sequence = 0;

describe.skipIf(!url)('MongoDB integration', () => {
	defineConversationStreamStoreContractTests('MongoDB conversation store', {
		async create() {
			if (!url) throw new Error('FLUE_TEST_MONGODB_URL is required.');
			const client = new MongoClient(url);
			clients.push(client);
			await client.connect();
			const db = client.db(`flue_cleanup_${process.pid}_${sequence++}`);
			const operations = (session?: ClientSession): MongoOperations => ({
				collection(name) {
					const collection = db.collection<MongoDocument>(name);
					return {
						findOne: (filter, options) => collection.findOne(filter, { ...options, session }),
						find: (filter = {}, options) =>
							collection.find(filter, { ...options, session }).toArray(),
						insertOne: (document) => collection.insertOne(document, { session }),
						insertMany: (documents) => collection.insertMany(documents, { session }),
						updateOne: (filter, update, options) =>
							collection.updateOne(filter, update, { ...options, session }),
						updateMany: (filter, update) => collection.updateMany(filter, update, { session }),
						findOneAndUpdate: (filter, update, options) =>
							collection.findOneAndUpdate(filter, update, { ...options, session }),
						deleteOne: (filter) => collection.deleteOne(filter, { session }),
						deleteMany: (filter) => collection.deleteMany(filter, { session }),
					};
				},
			});
			const runner: MongoRunner = {
				...operations(),
				transaction: (fn) =>
					runMongoTransactionWithRetry(
						() => {
							const session = client.startSession();
							return {
								start: () =>
									session.startTransaction({
										readConcern: { level: 'snapshot' },
										writeConcern: { w: 'majority' },
									}),
								commit: () => session.commitTransaction(),
								abort: () => session.abortTransaction(),
								end: () => session.endSession(),
								operations: operations(session),
							};
						},
						fn,
						{
							hasErrorLabel: (error, label) =>
								typeof error === 'object' &&
								error !== null &&
								'hasErrorLabel' in error &&
								typeof error.hasErrorLabel === 'function' &&
								error.hasErrorLabel(label),
						},
					),
				async topology() {
					const hello = await db.admin().command({ hello: 1 });
					return {
						kind: hello.setName ? 'replica_set' : 'standalone',
						transactions: Boolean(hello.setName),
					};
				},
				async ensureCollection(spec) {
					if (!(await db.listCollections({ name: spec.name }).hasNext())) {
						await db.createCollection(spec.name, {
							validator: spec.validator,
							validationLevel: spec.validationLevel,
							validationAction: spec.validationAction,
						});
					}
					for (const { key, ...options } of spec.indexes)
						await db.collection(spec.name).createIndex(key, options);
				},
				async inspectCollection(name) {
					const info = await db.listCollections({ name }).next();
					if (!info || !('options' in info)) return null;
					const indexes = (await db.collection(name).listIndexes().toArray()).filter(
						(index) => index.name !== '_id_',
					);
					return {
						validator: info.options?.validator ?? {},
						validationLevel: info.options?.validationLevel ?? 'strict',
						validationAction: info.options?.validationAction ?? 'error',
						indexes: indexes.map((index) => ({
							name: String(index.name),
							key: index.key,
							...(index.unique ? { unique: true } : {}),
							...(index.partialFilterExpression
								? { partialFilterExpression: index.partialFilterExpression }
								: {}),
							...(index.collation ? { collation: { locale: index.collation.locale } } : {}),
						})),
					};
				},
				close: () => client.close(),
			};
			const adapter = mongodb(runner);
			await adapter.migrate?.();
			const connection = await adapter.connect();
			return {
				stream: connection.conversationStreamStore,
				submissionStore: connection.submissionStore,
			};
		},
		async cleanup() {
			for (const client of clients.splice(0)) await client.close();
		},
	});
});
