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
			{ name: 'owner_state_updated', key: { owner: 1, state: 1, updatedAt: 1 }, collation: simple },
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
		]),
		spec('journals', [
			{ name: 'submission_id', key: { submissionId: 1 }, unique: true, collation: simple },
		]),
		spec('markers', [
			{
				name: 'submission_attempt',
				key: { submissionId: 1, attemptId: 1 },
				unique: true,
				collation: simple,
			},
		]),
		spec('runs', [
			{ name: 'run_id', key: { runId: 1 }, unique: true, collation: simple },
			{ name: 'started_run', key: { startedAt: -1, runId: -1 }, collation: simple },
			{
				name: 'status_started_run',
				key: { status: 1, startedAt: -1, runId: -1 },
				collation: simple,
			},
			{
				name: 'workflow_started_run',
				key: { workflowName: 1, startedAt: -1, runId: -1 },
				collation: simple,
			},
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
			{ name: 'path_attachment', key: { path: 1, attachmentId: 1 }, unique: true, collation: simple },
			{ name: 'path_owner_attachment', key: { path: 1, ownerKind: 1, ownerId: 1, attachmentId: 1 }, collation: simple },
		]),
		spec('event_streams'),
		spec('event_entries', [
			{ name: 'path_offset', key: { path: 1, offset: 1 }, unique: true, collation: simple },
			{
				name: 'path_event_key',
				key: { path: 1, eventKey: 1 },
				unique: true,
				partialFilterExpression: { eventKey: { $type: 'string' } },
				collation: simple,
			},
		]),
	];
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
			if (canonical(actualByName.get(index.name)) !== canonical(index))
				throw new TypeError(
					`MongoDB collection ${expected.name} has an incompatible ${index.name} index.`,
				);
	}
}
