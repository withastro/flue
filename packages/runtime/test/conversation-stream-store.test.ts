import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { ConversationStreamStoreError } from '../src/errors.ts';
import {
	InMemoryConversationStreamStore,
	SqliteConversationStreamStore,
} from '../src/runtime/conversation-stream-store.ts';
import {
	createSqlAgentExecutionStoreFromSql,
	ensureSqlAgentExecutionTables,
} from '../src/sql-agent-execution-store.ts';
import { defineConversationStreamStoreContractTests } from '../src/test-utils/define-conversation-stream-store-contract-tests.ts';

function createStores() {
	const db = new DatabaseSync(':memory:');
	const sql = {
		exec(query: string, ...bindings: unknown[]) {
			const statement = db.prepare(query);
			if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query) || /\bRETURNING\b/i.test(query)) {
				return {
					toArray: () => statement.all(...(bindings as never[])) as Record<string, unknown>[],
				};
			}
			statement.run(...(bindings as never[]));
			return { toArray: () => [] as Record<string, unknown>[] };
		},
	};
	const transaction = <T>(closure: () => T): T => {
		db.exec('BEGIN');
		try {
			const result = closure();
			db.exec('COMMIT');
			return result;
		} catch (error) {
			db.exec('ROLLBACK');
			throw error;
		}
	};
	ensureSqlAgentExecutionTables(sql);
	return {
		db,
		stream: new SqliteConversationStreamStore(sql, transaction),
		executionStore: createSqlAgentExecutionStoreFromSql(sql, transaction),
	};
}

defineConversationStreamStoreContractTests('SqliteConversationStreamStore contract', {
	create: createStores,
});

defineConversationStreamStoreContractTests('InMemoryConversationStreamStore contract', {
	create: () => ({
		stream: new InMemoryConversationStreamStore(),
	}),
});

describe('InMemoryConversationStreamStore', () => {
	it('rejects conflicting identity without replacing the stream', async () => {
		const stream = new InMemoryConversationStreamStore();
		await stream.createStream('runs/1', { agentName: 'workflow', instanceId: '1' });

		await expect(
			stream.createStream('runs/1', { agentName: 'workflow', instanceId: '2' }),
		).rejects.toBeInstanceOf(ConversationStreamStoreError);
		expect(await stream.getMeta('runs/1')).toMatchObject({
			identity: { agentName: 'workflow', instanceId: '1' },
		});
	});

	it('fences a claim from a physically deleted stream incarnation', async () => {
		const stream = new InMemoryConversationStreamStore();
		await stream.createStream('runs/1', { agentName: 'workflow', instanceId: '1' });
		const stale = await stream.acquireProducer('runs/1', 'workflow-1');
		await stream.delete('runs/1');
		await stream.createStream('runs/1', { agentName: 'workflow', instanceId: '1' });
		await stream.acquireProducer('runs/1', 'workflow-1');

		await expect(
			stream.append({
				path: 'runs/1',
				producerId: stale.producerId,
				producerEpoch: stale.producerEpoch,
				incarnation: stale.incarnation,
				producerSequence: 0,
				records: [userRecord('record_1', 'entry_1')],
			}),
		).rejects.toBeInstanceOf(ConversationStreamStoreError);
	});
});

function userRecord(id: string, messageId: string): ConversationRecord {
	return {
		v: 1,
		id,
		type: 'user_message',
		conversationId: 'conv_01',
		harness: 'default',
		session: 'default',
		timestamp: '2026-06-25T00:00:00.000Z',
		messageId,
		parentId: null,
		content: [{ type: 'text', text: messageId }],
	};
}

describe('SqliteConversationStreamStore', () => {
	it('appends an atomic ordered batch when producer ownership is current', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const producer = await stream.acquireProducer('agents/echo/1', 'coordinator-1');

		const result = await stream.append({
			path: 'agents/echo/1',
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: 0,
			records: [userRecord('record_1', 'entry_1'), userRecord('record_2', 'entry_2')],
		});

		expect(result.offset).toBe('0000000000000000_0000000000000000');
		expect(await stream.read('agents/echo/1')).toMatchObject({
			batches: [{ offset: result.offset, records: [{ id: 'record_1' }, { id: 'record_2' }] }],
			nextOffset: result.offset,
			upToDate: true,
		});
	});

	it('returns the original offset for an exact uncertain retry without notifying twice', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const producer = await stream.acquireProducer('agents/echo/1', 'coordinator-1');
		const listener = vi.fn();
		stream.subscribe('agents/echo/1', listener);
		const input = {
			path: 'agents/echo/1',
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: 0,
			records: [userRecord('record_1', 'entry_1')],
		};

		const first = await stream.append(input);
		const retry = await stream.append(input);

		expect(retry).toEqual(first);
		expect(listener).toHaveBeenCalledTimes(1);
	});

	it('rejects conflicting retries without consuming an offset or producer sequence', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const producer = await stream.acquireProducer('agents/echo/1', 'coordinator-1');
		await stream.append({
			path: 'agents/echo/1',
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: 0,
			records: [userRecord('record_1', 'entry_1')],
		});

		await expect(
			stream.append({
				path: 'agents/echo/1',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [userRecord('record_2', 'entry_2')],
			}),
		).rejects.toBeInstanceOf(ConversationStreamStoreError);
		expect(await stream.getMeta('agents/echo/1')).toMatchObject({
			nextOffset: '0000000000000000_0000000000000000',
			nextProducerSequence: 1,
		});
	});

	it('fences every append from a replaced coordinator epoch', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const stale = await stream.acquireProducer('agents/echo/1', 'coordinator-1');
		const current = await stream.acquireProducer('agents/echo/1', 'coordinator-2');

		await expect(
			stream.append({
				path: 'agents/echo/1',
				producerId: stale.producerId,
				producerEpoch: stale.producerEpoch,
				incarnation: stale.incarnation,
				producerSequence: 0,
				records: [userRecord('record_stale', 'entry_stale')],
			}),
		).rejects.toBeInstanceOf(ConversationStreamStoreError);
		expect(current.producerEpoch).toBe(stale.producerEpoch + 1);
	});

	it('rejects a stale claim after physical deletion and path recreation', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const stale = await stream.acquireProducer('agents/echo/1', 'coordinator-1');
		await stream.delete('agents/echo/1');
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		await stream.acquireProducer('agents/echo/1', 'coordinator-1');

		await expect(
			stream.append({
				path: 'agents/echo/1',
				producerId: stale.producerId,
				producerEpoch: stale.producerEpoch,
				incarnation: stale.incarnation,
				producerSequence: 0,
				records: [userRecord('record_stale', 'entry_stale')],
			}),
		).rejects.toBeInstanceOf(ConversationStreamStoreError);
	});

	it('rejects a future resume offset before it can skip later canonical batches', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });

		await expect(
			stream.read('agents/echo/1', {
				offset: '0000000000000000_0000000000001000',
			}),
		).rejects.toBeInstanceOf(ConversationStreamStoreError);
	});

	it('does not report a committed append as failed when a live listener throws', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const producer = await stream.acquireProducer('agents/echo/1', 'coordinator-1');
		stream.subscribe('agents/echo/1', () => {
			throw new Error('listener failure');
		});

		await expect(
			stream.append({
				path: 'agents/echo/1',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [userRecord('record_1', 'entry_1')],
			}),
		).resolves.toMatchObject({ offset: '0000000000000000_0000000000000000' });
	});

	it('physically deletes canonical batches at instance deletion', async () => {
		const { stream } = createStores();
		await stream.createStream('agents/echo/1', { agentName: 'echo', instanceId: '1' });
		const producer = await stream.acquireProducer('agents/echo/1', 'coordinator-1');
		await stream.append({
			path: 'agents/echo/1',
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: 0,
			records: [userRecord('record_1', 'entry_1')],
		});

		await stream.delete('agents/echo/1');

		expect(await stream.getMeta('agents/echo/1')).toBeNull();
		expect(await stream.read('agents/echo/1')).toMatchObject({ batches: [], nextOffset: '-1' });
	});
});
