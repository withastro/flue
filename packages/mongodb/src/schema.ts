import type {
	MongoCollectionSpec,
	MongoDocument,
	MongoIndexSpec,
	MongoRunner,
} from './mongodb-runner.ts';

const simple = { locale: 'simple' as const };
const validator = { $jsonSchema: { bsonType: 'object', required: ['_id'] } };

export function collectionName(prefix: string, name: string): string {
	return `${prefix}${name}`;
}

export function schema(prefix: string): MongoCollectionSpec[] {
	const spec = (name: string, indexes: MongoIndexSpec[] = []): MongoCollectionSpec => ({
		name: collectionName(prefix, name),
		validator,
		validationLevel: 'strict',
		validationAction: 'error',
		indexes,
	});
	return [
		spec('meta'),
		spec('counters'),
		spec('value_generations', [
			// Every value_generations query filters by _id or by
			// { state, createdAt } (collectGarbage) — state_created is the
			// only secondary index any of them can use.
			{ name: 'state_created', key: { state: 1, createdAt: 1 } },
		]),
		spec('values', [{ name: 'generation_index', key: { generation: 1, index: 1 }, unique: true }]),
		spec('submissions', [
			{ name: 'submission_id', key: { submissionId: 1 }, unique: true, collation: simple },
			{ name: 'status_sequence', key: { status: 1, sequence: 1 } },
			{
				name: 'session_status_sequence',
				key: { sessionKey: 1, status: 1, sequence: 1 },
				collation: simple,
			},
			{ name: 'joined_into', key: { joinedInto: 1 }, collation: simple },
		]),
		spec('conversation_streams'),
		spec('conversation_batches', [
			{ name: 'path_offset', key: { path: 1, offset: 1 }, unique: true, collation: simple },
			{
				name: 'producer_sequence',
				key: { path: 1, producerId: 1, producerEpoch: 1, producerSequence: 1 },
				unique: true,
				collation: simple,
			},
		]),
		spec('attachments', [
			{
				name: 'path_attachment',
				key: { path: 1, attachmentId: 1 },
				unique: true,
				collation: simple,
			},
		]),
	];
}

/**
 * MongoDB represents simple binary collation by omitting the collation field
 * from the persisted index, so an expected simple collation matches an index
 * reported without one.
 */
function comparableIndex(index: MongoIndexSpec | undefined): string {
	if (!index) return canonical(index);
	const { collation, ...rest } = index;
	return canonical(collation && collation.locale !== 'simple' ? { ...rest, collation } : rest);
}

function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value && typeof value === 'object')
		return `{${Object.entries(value as MongoDocument)
			.filter(([, entry]) => entry !== undefined)
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
			.join(',')}}`;
	return JSON.stringify(value);
}

export async function ensureSchema(runner: MongoRunner, prefix: string): Promise<void> {
	for (const expected of schema(prefix)) await runner.ensureCollection(expected);
	for (const expected of schema(prefix)) {
		const actual = await runner.inspectCollection(expected.name);
		if (
			!actual ||
			canonical(actual.validator) !== canonical(expected.validator) ||
			actual.validationLevel !== expected.validationLevel ||
			actual.validationAction !== expected.validationAction
		)
			throw new TypeError(
				`MongoDB collection ${expected.name} has incompatible validation options.`,
			);
		const actualByName = new Map(actual.indexes.map((index) => [index.name, index]));
		for (const index of expected.indexes)
			if (comparableIndex(actualByName.get(index.name)) !== comparableIndex(index))
				throw new TypeError(
					`MongoDB collection ${expected.name} has an incompatible ${index.name} index.`,
				);
	}
}
