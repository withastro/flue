import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { init } from './agent-client.ts';
import type { PersistenceAdapter } from './agent-execution-store.ts';
import type { ConversationRecord } from './conversation-records.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { useAgentStart } from './hooks/use-agent-start.ts';
import { useDelivery } from './hooks/use-delivery.ts';
import { useModel } from './hooks/use-model.ts';
import { usePersistentState } from './hooks/use-persistent-state.ts';
import {
	assertLocalQueueAcknowledgment,
	type LocalQueueAcknowledgment,
} from './local-queue-acknowledgment.ts';
import { sqlite } from './node/agent-execution-store.ts';
import { assembleNodeAgentRuntime } from './node/assemble.ts';
import { type Flue, start } from './node/start.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { setProvider } from './runtime/providers.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import type { Agent, DispatchReceipt } from './types.ts';

const cleanups: Array<() => void | Promise<void>> = [];
let runtime: Pick<Flue, 'stop'> | undefined;

afterEach(async () => {
	try {
		await runtime?.stop();
	} finally {
		runtime = undefined;
		for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	}
});

async function database() {
	const directory = mkdtempSync(join(tmpdir(), 'flue-start-ack-'));
	cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
	const path = join(directory, 'agent.sqlite');
	const db = new DatabaseSync(path);
	cleanups.push(() => db.close());
	db.exec('CREATE TABLE app_notes (note_key TEXT PRIMARY KEY, body TEXT NOT NULL)');
	const adapter = sqlite(path);
	cleanups.push(() => adapter.close?.());
	await adapter.migrate?.();
	const stores = await adapter.connect();
	const stream = stores.conversationStreamStore;
	const appendAcknowledged = stream.appendWithLocalAcknowledgments?.bind(stream);
	if (!appendAcknowledged) throw new Error('The SQLite store must support local acknowledgments.');
	return {
		path,
		db,
		adapter,
		stores,
		stream,
		appendAcknowledged,
		queue(key: string, body = key) {
			db.prepare('INSERT INTO app_notes (note_key, body) VALUES (?, ?)').run(key, body);
		},
		queued() {
			return db.prepare('SELECT note_key, body FROM app_notes ORDER BY note_key').all();
		},
		async records(agentName = 'Notes') {
			const result = await stream.read(agentStreamPath(agentName, 'test'), { limit: 1000 });
			return result.batches.flatMap((batch) => batch.records);
		},
	};
}

function acknowledgment(key: string) {
	return { table: 'app_notes', key: { note_key: key } };
}

function provider() {
	return fauxProvider({ provider: 'ack-test', models: [{ id: 'notes' }] });
}

async function startCoordinator(
	agent: Agent,
	adapter: PersistenceAdapter,
	faux: ReturnType<typeof provider>,
) {
	setProvider(faux.provider);
	const assembled = await assembleNodeAgentRuntime({
		agents: [{ identity: 'Notes', agent }],
		adapter,
		stores: await adapter.connect(),
	});
	runtime = { stop: () => assembled.close() };
	return assembled.coordinator;
}

describe('start hook local acknowledgments', () => {
	it('commits in declaration order and retains a reused key after restart', async () => {
		const fixture = await database();
		fixture.queue('first');
		fixture.queue('second');
		fixture.db.exec(`
			CREATE TABLE note_deletions (sequence INTEGER PRIMARY KEY, note_key TEXT);
			CREATE TRIGGER record_note_deletion AFTER DELETE ON app_notes
			BEGIN INSERT INTO note_deletions (note_key) VALUES (OLD.note_key); END;
		`);
		const secondStaged = Promise.withResolvers<void>();
		const calls = [0, 0];
		const faux = provider();
		faux.setResponses([fauxAssistantMessage('done')]);
		function Notes() {
			useModel('ack-test/notes');
			const [, setCount] = usePersistentState('count', 0);
			useAgentStart(async ({ append }) => {
				calls[0] = (calls[0] ?? 0) + 1;
				await secondStaged.promise;
				const key = acknowledgment('first');
				append({ kind: 'signal', type: 'note', body: 'first' }, { acknowledge: key });
				key.key.note_key = 'second';
				setCount(1);
				expect(fixture.queued()).toHaveLength(2);
			});
			useAgentStart(({ append }) => {
				calls[1] = (calls[1] ?? 0) + 1;
				append(
					{ kind: 'signal', type: 'note', body: 'second' },
					{ acknowledge: acknowledgment('second') },
				);
				secondStaged.resolve();
			});
			return 'Read the notes.';
		}
		runtime = await start({ agents: [Notes], db: fixture.adapter, providers: [faux.provider] });
		const handle = init(Notes, { id: 'test' });
		const receipt = await handle.dispatch('start');
		expect((await handle.read(receipt)).text).toBe('done');
		expect(calls).toEqual([1, 1]);
		expect(faux.state.callCount).toBe(1);
		expect(fixture.queued()).toEqual([]);
		expect(
			fixture.db.prepare('SELECT note_key FROM note_deletions ORDER BY sequence').all(),
		).toEqual([{ note_key: 'first' }, { note_key: 'second' }]);
		const { batches } = await fixture.stream.read(agentStreamPath('Notes', 'test'));
		const startBatches = batches.filter((batch) =>
			batch.records.some((record) => record.type === 'agent_start_run'),
		);
		expect(startBatches).toHaveLength(1);
		expect(startBatches[0]?.records.map((record) => record.type)).toEqual([
			'signal',
			'signal',
			'state_write',
			'agent_start_run',
		]);
		const signals = startBatches[0]?.records.filter((record) => record.type === 'signal');
		expect(signals?.map((record) => record.content)).toEqual(['first', 'second']);
		expect(signals?.[1]?.parentId).toBe(signals?.[0]?.messageId);
		expect(startBatches[0]?.records[2]).toMatchObject({ name: 'count', value: 1 });
		await runtime.stop();
		runtime = undefined;
		fixture.queue('first', 'later note');
		runtime = await start({
			agents: [Notes],
			db: sqlite(fixture.path),
			providers: [faux.provider],
		});
		expect((await init(Notes, { id: 'test' }).read(receipt)).text).toBe('done');
		expect(calls).toEqual([1, 1]);
		expect(faux.state.callCount).toBe(1);
		expect(fixture.queued()).toEqual([{ note_key: 'first', body: 'later note' }]);
	});

	it.each(['later hook', 'batch', 'acknowledgment'] as const)(
		'keeps queued rows and start output unchanged when the %s fails',
		async (failure) => {
			const fixture = await database();
			fixture.queue('first');
			fixture.queue('second');
			if (failure === 'batch') {
				fixture.db.exec(`
					CREATE TRIGGER reject_start BEFORE INSERT ON flue_conversation_stream_batches
					WHEN EXISTS (
						SELECT 1 FROM json_each(NEW.data) WHERE json_extract(value, '$.type') = 'agent_start_run'
					)
					BEGIN SELECT RAISE(ABORT, 'start batch refused'); END
				`);
			}
			if (failure === 'acknowledgment') {
				fixture.db.exec(`
					CREATE TRIGGER reject_ack BEFORE DELETE ON app_notes
					WHEN OLD.note_key = 'second'
					BEGIN SELECT RAISE(ABORT, 'ack refused'); END
				`);
			}
			const calls = [0, 0];
			const firstStaged = Promise.withResolvers<void>();
			const faux = provider();
			function Notes() {
				useModel('ack-test/notes');
				const [, setCount] = usePersistentState('count', 0);
				useAgentStart(({ append }) => {
					calls[0] = (calls[0] ?? 0) + 1;
					for (const key of ['first', 'second']) {
						append(
							{ kind: 'signal', type: 'note', body: key },
							{ acknowledge: acknowledgment(key) },
						);
					}
					setCount(1);
					expect(fixture.queued()).toHaveLength(2);
					firstStaged.resolve();
				});
				useAgentStart(async () => {
					calls[1] = (calls[1] ?? 0) + 1;
					await firstStaged.promise;
					if (failure === 'later hook') throw new Error('later hook refused');
				});
				return 'Read the notes.';
			}
			const coordinator = await startCoordinator(Notes, fixture.adapter, faux);
			const handle = init(Notes, { id: 'test' });
			const receipt = await handle.dispatch('start');
			await coordinator.waitForIdle();
			expect(
				(await fixture.stores.submissionStore.getSubmission(receipt.submissionId))?.attemptCount,
			).toBe(1);
			expect(calls).toEqual([1, 1]);
			expect(faux.state.callCount).toBe(0);
			expect(fixture.queued()).toEqual([
				{ note_key: 'first', body: 'first' },
				{ note_key: 'second', body: 'second' },
			]);
			const records = await fixture.records();
			expect(records.filter((record) => record.type === 'agent_start_run')).toEqual([]);
			expect(records.filter((record) => record.type === 'state_write')).toEqual([]);
			expect(
				records.filter((record) => record.type === 'signal' && record.signalType === 'note'),
			).toEqual([]);
		},
	);

	it('acknowledges a joined delivery without an extra delivery or model call', async () => {
		const fixture = await database();
		const firstTurn = Promise.withResolvers<void>();
		const releaseTurn = Promise.withResolvers<void>();
		const faux = provider();
		faux.setResponses([
			async () => {
				firstTurn.resolve();
				await releaseTurn.promise;
				return fauxAssistantMessage('first reply');
			},
			fauxAssistantMessage('joined reply'),
		]);
		const deliveries: string[] = [];
		function Notes() {
			useModel('ack-test/notes');
			const delivery = useDelivery();
			useAgentStart(({ append }) => {
				deliveries.push(delivery.body);
				if (delivery.body !== 'joined') return;
				append(
					{ kind: 'signal', type: 'note', body: 'joined note' },
					{ acknowledge: acknowledgment('joined') },
				);
			});
			return 'Read the notes.';
		}
		runtime = await start({ agents: [Notes], db: fixture.adapter, providers: [faux.provider] });
		const handle = init(Notes, { id: 'test' });
		const host = await handle.dispatch('host');
		await firstTurn.promise;
		let joined: DispatchReceipt;
		try {
			fixture.queue('joined');
			joined = await handle.dispatch('joined');
		} finally {
			releaseTurn.resolve();
		}
		expect((await handle.read(host)).text).toBe('first reply\n\njoined reply');
		expect((await handle.read(joined)).text).toBe('first reply\n\njoined reply');
		expect(deliveries).toEqual(['host', 'joined']);
		expect(faux.state.callCount).toBe(2);
		expect(fixture.queued()).toEqual([]);
		const records = await fixture.records();
		expect(
			records
				.filter((record) => record.type === 'agent_start_run')
				.map((record) => record.submissionId),
		).toEqual([host.submissionId, joined.submissionId]);
		const notes = records.filter(
			(record) => record.type === 'signal' && record.signalType === 'note',
		);
		expect(notes).toHaveLength(1);
		expect(notes[0]).toMatchObject({ submissionId: host.submissionId, content: 'joined note' });
	});

	it.each([false, true])(
		'handles a store without the capability (acknowledge: %s)',
		async (acknowledge) => {
			const fixture = await database();
			fixture.queue('first');
			const stream = fixture.stream;
			const adapter: PersistenceAdapter = {
				connect: () => ({
					...fixture.stores,
					conversationStreamStore: {
						createStream: stream.createStream.bind(stream),
						acquireProducer: stream.acquireProducer.bind(stream),
						append: stream.append.bind(stream),
						read: stream.read.bind(stream),
						getMeta: stream.getMeta.bind(stream),
						subscribe: stream.subscribe.bind(stream),
					},
				}),
			};
			const faux = provider();
			faux.setResponses([fauxAssistantMessage('done')]);
			let calls = 0;
			function Notes() {
				useModel('ack-test/notes');
				useAgentStart(({ append }) => {
					calls += 1;
					append(
						{ kind: 'signal', type: 'note', body: 'first' },
						acknowledge ? { acknowledge: acknowledgment('first') } : undefined,
					);
				});
				return 'Read the note.';
			}
			const coordinator = await startCoordinator(Notes, adapter, faux);
			const handle = init(Notes, { id: 'test' });
			const receipt = await handle.dispatch('start');
			await coordinator.waitForIdle();
			if (!acknowledge) {
				expect((await handle.read(receipt)).text).toBe('done');
			}
			expect(calls).toBe(1);
			expect(faux.state.callCount).toBe(acknowledge ? 0 : 1);
			expect(fixture.queued()).toEqual([{ note_key: 'first', body: 'first' }]);
			const records = await fixture.records();
			expect(records.filter((record) => record.type === 'agent_start_run')).toHaveLength(
				acknowledge ? 0 : 1,
			);
			expect(
				records.filter((record) => record.type === 'signal' && record.signalType === 'note'),
			).toHaveLength(acknowledge ? 0 : 1);
		},
	);
});

function signalRecord(): ConversationRecord {
	return {
		v: 1,
		id: 'note-record',
		type: 'signal',
		timestamp: '2026-09-12T00:00:00.000Z',
		conversationId: 'conversation',
		harness: 'default',
		session: 'default',
		messageId: 'note-message',
		parentId: null,
		signalType: 'note',
		content: 'first',
	};
}

describe('local acknowledgment transaction and replay', () => {
	it.each(['constructor', 'prototype', '__proto__'])(
		'preserves the %s column in a row key',
		async (column) => {
			const fixture = await database();
			fixture.db.exec(`CREATE TABLE app_versions (id INTEGER PRIMARY KEY, "${column}" TEXT)`);
			fixture.db.prepare('INSERT INTO app_versions VALUES (?, ?)').run(1, 'current');
			const path = agentStreamPath('Notes', 'test');
			await fixture.stream.createStream(path, { agentName: 'Notes', instanceId: 'test' });
			const claim = await fixture.stream.acquireProducer(path, 'producer');
			const input = { ...claim, path, producerSequence: 0, records: [signalRecord()] };
			const key = { id: 1, [column]: 'stale' };
			await expect(
				fixture.appendAcknowledged(input, [{ table: 'app_versions', key }]),
			).rejects.toThrow('exactly one');
			expect(fixture.db.prepare('SELECT id FROM app_versions').all()).toEqual([{ id: 1 }]);
			expect((await fixture.stream.read(path)).batches).toEqual([]);
			key[column] = 'current';
			await fixture.appendAcknowledged(input, [{ table: 'app_versions', key }]);
			expect(fixture.db.prepare('SELECT id FROM app_versions').all()).toEqual([]);
			expect((await fixture.stream.read(path)).batches).toHaveLength(1);
		},
	);

	it('returns a committed batch after reopening without acknowledging a reused key', async () => {
		const fixture = await database();
		fixture.queue('first');
		const path = agentStreamPath('Notes', 'test');
		await fixture.stream.createStream(path, { agentName: 'Notes', instanceId: 'test' });
		const claim = await fixture.stream.acquireProducer(path, 'producer');
		const input = { ...claim, path, producerSequence: 0, records: [signalRecord()] };
		const committed = await fixture.appendAcknowledged(input, [acknowledgment('first')]);
		await fixture.adapter.close?.();
		fixture.queue('first', 'after restart');
		const reopened = sqlite(fixture.path);
		cleanups.push(() => reopened.close?.());
		const { conversationStreamStore: stream } = await reopened.connect();
		if (!stream.appendWithLocalAcknowledgments)
			throw new Error('Missing local acknowledgment method.');
		expect(await stream.appendWithLocalAcknowledgments(input, [acknowledgment('first')])).toEqual(
			committed,
		);
		expect(fixture.queued()).toEqual([{ note_key: 'first', body: 'after restart' }]);
		expect((await stream.read(path)).batches).toHaveLength(1);
	});

	it('preserves the submission attempt check before applying an acknowledgment', async () => {
		const fixture = await database();
		fixture.queue('first');
		const path = agentStreamPath('Notes', 'test');
		const { submissionStore } = fixture.stores;
		await submissionStore.admitDirect({
			kind: 'direct',
			agent: 'Notes',
			id: 'test',
			submissionId: 'submission',
			message: { kind: 'user', body: 'start' },
			acceptedAt: '2026-09-12T00:00:00.000Z',
		});
		await submissionStore.markSubmissionCanonicalReady('submission');
		await submissionStore.claimSubmission({
			submissionId: 'submission',
			attemptId: 'current',
			ownerId: 'producer',
			leaseExpiresAt: Date.now() + 30_000,
		});
		await fixture.stream.createStream(path, { agentName: 'Notes', instanceId: 'test' });
		const claim = await fixture.stream.acquireProducer(path, 'producer');
		await expect(
			fixture.appendAcknowledged(
				{
					...claim,
					path,
					producerSequence: 0,
					submission: { submissionId: 'submission', attemptId: 'stale' },
					records: [{ ...signalRecord(), submissionId: 'submission', attemptId: 'stale' }],
				},
				[acknowledgment('first')],
			),
		).rejects.toThrow();
		expect(fixture.queued()).toHaveLength(1);
		expect((await fixture.stream.read(path)).batches).toEqual([]);
		expect((await fixture.stream.getMeta(path))?.nextProducerSequence).toBe(0);
	});

	it('binds string, number, and null values in a composite row key', async () => {
		const fixture = await database();
		fixture.db.exec('CREATE TABLE app_composite (id INTEGER PRIMARY KEY, scope TEXT, body TEXT)');
		const body = '"; DELETE FROM app_composite; --';
		fixture.db.prepare('INSERT INTO app_composite VALUES (?, ?, ?)').run(1, null, body);
		fixture.db.prepare('INSERT INTO app_composite VALUES (?, ?, ?)').run(2, null, body);
		const path = agentStreamPath('Notes', 'test');
		await fixture.stream.createStream(path, { agentName: 'Notes', instanceId: 'test' });
		const claim = await fixture.stream.acquireProducer(path, 'producer');
		await fixture.appendAcknowledged(
			{ ...claim, path, producerSequence: 0, records: [signalRecord()] },
			[{ table: 'app_composite', key: { id: 1, scope: null, body } }],
		);
		expect(fixture.db.prepare('SELECT id FROM app_composite').all()).toEqual([{ id: 2 }]);
		expect((await fixture.stream.read(path)).batches).toHaveLength(1);
	});

	it('retries a lost commit response without deleting a later row with the same key', async () => {
		const fixture = await database();
		fixture.queue('first');
		let attempts = 0;
		const stream = fixture.stream;
		const store = {
			createStream: stream.createStream.bind(stream),
			acquireProducer: stream.acquireProducer.bind(stream),
			append: stream.append.bind(stream),
			read: stream.read.bind(stream),
			getMeta: stream.getMeta.bind(stream),
			subscribe: stream.subscribe.bind(stream),
			async appendWithLocalAcknowledgments(...args: Parameters<typeof fixture.appendAcknowledged>) {
				attempts += 1;
				const result = await fixture.appendAcknowledged(...args);
				if (attempts === 1) {
					fixture.queue('first', 'later note');
					throw new Error('commit response lost');
				}
				return result;
			},
		};
		const path = agentStreamPath('Notes', 'test');
		const writer = await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: 'Notes', instanceId: 'test' },
			producerId: 'producer',
		});
		await writer.appendWithLocalAcknowledgments([signalRecord()], [acknowledgment('first')]);
		expect(attempts).toBe(2);
		expect(fixture.queued()).toEqual([{ note_key: 'first', body: 'later note' }]);
		expect((await stream.read(path)).batches.map((batch) => batch.records)).toEqual([
			[signalRecord()],
		]);
		expect((await stream.getMeta(path))?.nextProducerSequence).toBe(1);
	});

	it('rolls back the batch when a key does not select exactly one row', async () => {
		const fixture = await database();
		fixture.queue('first', 'shared');
		fixture.queue('second', 'shared');
		const path = agentStreamPath('Notes', 'test');
		await fixture.stream.createStream(path, { agentName: 'Notes', instanceId: 'test' });
		const claim = await fixture.stream.acquireProducer(path, 'producer');
		const input = { ...claim, path, producerSequence: 0, records: [signalRecord()] };
		const keys: LocalQueueAcknowledgment['key'][] = [{ note_key: 'missing' }, { body: 'shared' }];
		for (const key of keys) {
			await expect(
				fixture.appendAcknowledged(input, [{ table: 'app_notes', key }]),
			).rejects.toThrow('exactly one');
			expect(fixture.queued()).toHaveLength(2);
			expect((await fixture.stream.read(path)).batches).toEqual([]);
			expect((await fixture.stream.getMeta(path))?.nextProducerSequence).toBe(0);
		}
	});

	it('rejects an acknowledgment with a stale producer before deleting the queue row', async () => {
		const fixture = await database();
		fixture.queue('first');
		const path = agentStreamPath('Notes', 'test');
		await fixture.stream.createStream(path, { agentName: 'Notes', instanceId: 'test' });
		const claim = await fixture.stream.acquireProducer(path, 'producer');
		await fixture.stream.acquireProducer(path, 'replacement');
		await expect(
			fixture.appendAcknowledged(
				{ ...claim, path, producerSequence: 0, records: [signalRecord()] },
				[acknowledgment('first')],
			),
		).rejects.toThrow();
		expect(fixture.queued()).toHaveLength(1);
		expect((await fixture.stream.read(path)).batches).toEqual([]);
	});

	it('refuses acknowledgments on the memory store without appending', async () => {
		const store = new InMemoryConversationStreamStore();
		const path = agentStreamPath('Notes', 'test');
		const writer = await ConversationRecordWriter.create({
			store,
			path,
			identity: { agentName: 'Notes', instanceId: 'test' },
			producerId: 'producer',
		});
		await expect(
			writer.appendWithLocalAcknowledgments([signalRecord()], [acknowledgment('first')]),
		).rejects.toThrow('does not support atomic local acknowledgments');
		expect((await store.read(path)).batches).toEqual([]);
	});

	it.each([
		{ table: 'flue_conversation_streams', key: { path: 'x' } },
		{ table: 'FLUE_records', key: { id: 1 } },
		{ table: 'sqlite_schema', key: { name: 'x' } },
		{ table: 'other.app_notes', key: { note_key: 'first' } },
		{ table: 'app_notes"; DELETE FROM app_notes; --', key: { note_key: 'first' } },
		{ table: 'app_notes', key: {} },
		{ table: 'app_notes', key: { 'note_key OR 1=1': 'first' } },
		{ table: 'app_notes', key: { note_key: Number.NaN } },
		{ table: 'app_notes', key: { note_key: Promise.resolve('first') } },
		async () => {},
	])('rejects an invalid local acknowledgment: %j', (value) => {
		expect(() => assertLocalQueueAcknowledgment(value)).toThrow('local acknowledgment requires');
	});
});
