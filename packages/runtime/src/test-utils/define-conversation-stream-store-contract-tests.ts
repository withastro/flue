import { afterEach, describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../conversation-records.ts';
import type {
	ConversationSnapshotStore,
	ConversationStreamStore,
} from '../runtime/conversation-stream-store.ts';

export interface ConversationStreamStoreContractBackend {
	create():
		| {
				stream: ConversationStreamStore;
				snapshots: ConversationSnapshotStore;
		  }
		| Promise<{
				stream: ConversationStreamStore;
				snapshots: ConversationSnapshotStore;
		  }>;
	cleanup?(): void | Promise<void>;
}

function userRecord(id: string, messageId: string): ConversationRecord {
	return {
		v: 1,
		id,
		type: 'user_message',
		conversationId: 'conv_contract',
		harness: 'default',
		session: 'default',
		timestamp: '2026-06-25T00:00:00.000Z',
		messageId,
		parentId: null,
		content: [{ type: 'text', text: messageId }],
	};
}

export function defineConversationStreamStoreContractTests(
	label: string,
	backend: ConversationStreamStoreContractBackend,
): void {
	describe(label, () => {
		let cleanup: (() => void | Promise<void>) | undefined;

		async function create() {
			cleanup = backend.cleanup;
			return backend.create();
		}

		afterEach(async () => {
			await cleanup?.();
			cleanup = undefined;
		});

		it('appends one ordered canonical batch when the producer is current', async () => {
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const result = await stream.append({
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [userRecord('record_1', 'entry_1'), userRecord('record_2', 'entry_2')],
			});

			expect(await stream.read('agents/echo/contract')).toMatchObject({
				batches: [{ offset: result.offset, records: [{ id: 'record_1' }, { id: 'record_2' }] }],
				nextOffset: result.offset,
				upToDate: true,
			});
		});

		it('returns the original offset for an exact producer retry', async () => {
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const input = {
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [userRecord('record_1', 'entry_1')],
			};

			expect(await stream.append(input)).toEqual(await stream.append(input));
			expect((await stream.read('agents/echo/contract')).batches).toHaveLength(1);
		});

		it('rejects conflicting producer retries without advancing the stream', async () => {
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			await stream.append({
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [userRecord('record_1', 'entry_1')],
			});

			await expect(
				stream.append({
					path: 'agents/echo/contract',
					producerId: producer.producerId,
					producerEpoch: producer.producerEpoch,
					incarnation: producer.incarnation,
					producerSequence: 0,
					records: [userRecord('record_2', 'entry_2')],
				}),
			).rejects.toThrow();
			expect(await stream.getMeta('agents/echo/contract')).toMatchObject({
				nextOffset: '0000000000000000_0000000000000000',
				nextProducerSequence: 1,
			});
		});

		it('fences stale producers after coordinator replacement', async () => {
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const stale = await stream.acquireProducer('agents/echo/contract', 'coordinator-1');
			await stream.acquireProducer('agents/echo/contract', 'coordinator-2');

			await expect(
				stream.append({
					path: 'agents/echo/contract',
					producerId: stale.producerId,
					producerEpoch: stale.producerEpoch,
					incarnation: stale.incarnation,
					producerSequence: 0,
					records: [userRecord('record_1', 'entry_1')],
				}),
			).rejects.toThrow();
		});

		it('replays strictly after a batch offset', async () => {
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const first = await stream.append({
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [userRecord('record_1', 'entry_1')],
			});
			await stream.append({
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 1,
				records: [userRecord('record_2', 'entry_2')],
			});

			expect(await stream.read('agents/echo/contract', { offset: first.offset })).toMatchObject({
				batches: [{ records: [{ id: 'record_2' }] }],
			});
		});

		it('deletes the physical stream and its disposable snapshot', async () => {
			const { stream, snapshots } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			await snapshots.save('agents/echo/contract', {
				version: 1,
				reducerVersion: 1,
				streamOffset: '-1',
				state: {},
				createdAt: '2026-06-25T00:00:00.000Z',
			});

			await stream.delete('agents/echo/contract');

			expect(await stream.getMeta('agents/echo/contract')).toBeNull();
			expect(await snapshots.load('agents/echo/contract')).toBeNull();
		});
	});
}
