import { describe, expect, it, vi } from 'vitest';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import {
	InMemoryConversationStreamStore,
	type ConversationStreamStore,
} from '../src/runtime/conversation-stream-store.ts';

function userRecord(id: string): ConversationRecord {
	return {
		v: 1,
		id,
		type: 'user_message',
		conversationId: 'conversation-1',
		harness: 'default',
		session: 'default',
		timestamp: '2026-01-01T00:00:00.000Z',
		messageId: `message-${id}`,
		parentId: null,
		content: [{ type: 'text', text: id }],
	};
}

describe('ConversationRecordWriter', () => {
	it('observes a timed flush failure without an unhandled rejection', async () => {
		vi.useFakeTimers();
		const failure = new Error('adapter failed');
		const base = new InMemoryConversationStreamStore();
		const store: ConversationStreamStore = {
			...base,
			createStream: base.createStream.bind(base),
			acquireProducer: base.acquireProducer.bind(base),
			append: async () => {
				throw failure;
			},
			read: base.read.bind(base),
			getMeta: base.getMeta.bind(base),
			close: base.close.bind(base),
			delete: base.delete.bind(base),
			subscribe: base.subscribe.bind(base),
		};
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/instance-1',
			identity: { agentName: 'assistant', instanceId: 'instance-1' },
			producerId: 'producer-1',
		});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on('unhandledRejection', onUnhandled);
		try {
			const pending = writer.enqueue([userRecord('record-1')]);
			const rejection = expect(pending).rejects.toBe(failure);
			await vi.advanceTimersByTimeAsync(3000);
			await rejection;
			vi.useRealTimers();
			await new Promise<void>((resolve) => setImmediate(resolve));
			expect(unhandled).toEqual([]);
		} finally {
			process.off('unhandledRejection', onUnhandled);
			vi.useRealTimers();
		}
	});

	it('rejects concurrent waiters and queued operations with the original failure', async () => {
		vi.useFakeTimers();
		const failure = new Error('adapter failed');
		let failAppend: (() => void) | undefined;
		const appendResult = new Promise<void>((_resolve, reject) => {
			failAppend = () => reject(failure);
		});
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const base = new InMemoryConversationStreamStore();
		const store: ConversationStreamStore = {
			...base,
			createStream: base.createStream.bind(base),
			acquireProducer: base.acquireProducer.bind(base),
			append: async () => {
				markStarted?.();
				await appendResult;
				return { offset: '-1' };
			},
			read: base.read.bind(base),
			getMeta: base.getMeta.bind(base),
			close: base.close.bind(base),
			delete: base.delete.bind(base),
			subscribe: base.subscribe.bind(base),
		};
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/instance-2',
			identity: { agentName: 'assistant', instanceId: 'instance-2' },
			producerId: 'producer-1',
		});
		const first = writer.enqueue([userRecord('record-1')]);
		const second = writer.enqueue([userRecord('record-2')]);
		await vi.advanceTimersByTimeAsync(3000);
		await started;
		const explicitFlush = writer.flush();
		const queued = writer.append([userRecord('record-3')]);
		failAppend?.();
		await expect(Promise.all([first, second, explicitFlush, queued])).rejects.toBe(failure);
		await expect(writer.append([userRecord('record-4')])).rejects.toBe(failure);
		await expect(writer.enqueue([userRecord('record-5')])).rejects.toBe(failure);
		await expect(writer.flush()).rejects.toBe(failure);
		await expect(writer.ensureConversation({
			kind: 'root',
			conversationId: 'conversation-2',
			harness: 'default',
			session: 'default',
			affinityKey: 'affinity-2',
			createdAt: '2026-01-01T00:00:00.000Z',
		})).rejects.toBe(failure);
		vi.useRealTimers();
	});

	it('preserves successful append and batched flush behavior', async () => {
		vi.useFakeTimers();
		const store = new InMemoryConversationStreamStore();
		const append = vi.spyOn(store, 'append');
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/instance-3',
			identity: { agentName: 'assistant', instanceId: 'instance-3' },
			producerId: 'producer-1',
		});
		const first = writer.enqueue([userRecord('record-1')]);
		const second = writer.enqueue([userRecord('record-2')]);
		await vi.advanceTimersByTimeAsync(3000);
		expect(await first).toEqual(await second);
		expect(append).toHaveBeenCalledTimes(1);
		expect(append.mock.calls[0]?.[0].records).toHaveLength(2);
		await expect(writer.append([userRecord('record-3')])).resolves.toHaveProperty('offset');
		expect(append).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
});
