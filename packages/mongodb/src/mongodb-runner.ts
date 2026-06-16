export type MongoDocument = Record<string, unknown>;
export type MongoFilter = Record<string, unknown>;
export type MongoUpdate = Record<string, unknown> | Record<string, unknown>[];

export interface MongoCursorOptions {
	sort?: Record<string, 1 | -1>;
	limit?: number;
	projection?: Record<string, 0 | 1>;
	collation?: { locale: string; [key: string]: unknown };
}

export interface MongoWriteResult {
	acknowledged: boolean;
	matchedCount?: number;
	modifiedCount?: number;
	deletedCount?: number;
	upsertedId?: unknown;
}

export interface MongoCollection {
	findOne(
		filter: MongoFilter,
		options?: {
			sort?: Record<string, 1 | -1>;
			projection?: Record<string, 0 | 1>;
			collation?: { locale: 'simple' };
		},
	): Promise<MongoDocument | null>;
	find(filter?: MongoFilter, options?: MongoCursorOptions): Promise<MongoDocument[]>;
	insertOne(document: MongoDocument): Promise<MongoWriteResult>;
	insertMany(documents: MongoDocument[]): Promise<MongoWriteResult>;
	updateOne(
		filter: MongoFilter,
		update: MongoUpdate,
		options?: { upsert?: boolean },
	): Promise<MongoWriteResult>;
	updateMany(filter: MongoFilter, update: MongoUpdate): Promise<MongoWriteResult>;
	findOneAndUpdate(
		filter: MongoFilter,
		update: MongoUpdate,
		options?: {
			upsert?: boolean;
			returnDocument?: 'before' | 'after';
			sort?: Record<string, 1 | -1>;
		},
	): Promise<MongoDocument | null>;
	deleteOne(filter: MongoFilter): Promise<MongoWriteResult>;
	deleteMany(filter: MongoFilter): Promise<MongoWriteResult>;
}

export interface MongoIndexSpec {
	name: string;
	key: Record<string, 1 | -1>;
	unique?: boolean;
	partialFilterExpression?: MongoFilter;
	collation?: { locale: string; [key: string]: unknown };
}

export interface MongoCollectionSpec {
	name: string;
	validator: MongoDocument;
	validationLevel: 'strict';
	validationAction: 'error';
	indexes: MongoIndexSpec[];
}

export interface MongoTopology {
	kind: 'replica_set' | 'sharded' | 'standalone' | 'unknown';
	transactions: boolean;
}

export interface MongoOperations {
	collection(name: string): MongoCollection;
}

export interface MongoRunner extends MongoOperations {
	transaction<T>(fn: (tx: MongoOperations) => Promise<T>): Promise<T>;
	topology(): Promise<MongoTopology>;
	ensureCollection(spec: MongoCollectionSpec): Promise<void>;
	inspectCollection(
		name: string,
	): Promise<{
		validator: MongoDocument;
		validationLevel: 'strict';
		validationAction: 'error';
		indexes: MongoIndexSpec[];
	} | null>;
	close(): void | Promise<void>;
}

export interface MongoTransactionSession {
	start(): void;
	commit(): Promise<void>;
	abort(): Promise<void>;
	end(): Promise<void>;
	operations: MongoOperations;
}

export interface MongoTransactionRetryOptions {
	maxTransactionAttempts?: number;
	maxCommitAttempts?: number;
	hasErrorLabel(
		error: unknown,
		label: 'TransientTransactionError' | 'UnknownTransactionCommitResult',
	): boolean;
}

export async function runMongoTransactionWithRetry<T>(
	createSession: () => MongoTransactionSession,
	fn: (operations: MongoOperations) => Promise<T>,
	options: MongoTransactionRetryOptions,
): Promise<T> {
	const maxTransactions = options.maxTransactionAttempts ?? 5;
	const maxCommits = options.maxCommitAttempts ?? 10;
	for (let transactionAttempt = 0; transactionAttempt < maxTransactions; transactionAttempt++) {
		const session = createSession();
		try {
			session.start();
			const value = await fn(session.operations);
			for (let commitAttempt = 0; commitAttempt < maxCommits; commitAttempt++) {
				try {
					await session.commit();
					return value;
				} catch (error) {
					if (
						!options.hasErrorLabel(error, 'UnknownTransactionCommitResult') ||
						commitAttempt + 1 === maxCommits
					)
						throw error;
				}
			}
		} catch (error) {
			await session.abort().catch(() => undefined);
			if (
				!options.hasErrorLabel(error, 'TransientTransactionError') ||
				transactionAttempt + 1 === maxTransactions
			)
				throw error;
		} finally {
			await session.end();
		}
	}
	throw new TypeError('MongoDB transaction retry limit exhausted.');
}

export interface MongoOptions {
	collectionPrefix?: string;
}
