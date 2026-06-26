import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../agent-execution-store.ts';
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
				executionStore?: AgentExecutionStore;
		  }
		| Promise<{
				stream: ConversationStreamStore;
				snapshots: ConversationSnapshotStore;
				executionStore?: AgentExecutionStore;
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

		it('appends only the exact reserved settlement while an attempt is terminalizing', async () => {
			const { stream, executionStore } = await create();
			if (!executionStore) return;
			await executionStore.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-1',
				agent: 'echo',
				id: 'contract',
				payload: { message: 'Hello' },
				acceptedAt: '2026-06-25T00:00:00.000Z',
			});
			await executionStore.submissions.markSubmissionCanonicalReady('direct-1');
			await executionStore.submissions.claimSubmission({
				submissionId: 'direct-1',
				attemptId: 'attempt-1',
				ownerId: 'coordinator',
				leaseExpiresAt: Date.now() + 30_000,
			});
			const record = {
				v: 1 as const,
				id: 'direct-1:settled',
				type: 'submission_settled' as const,
				conversationId: 'conv_contract',
				harness: 'default',
				session: 'default',
				timestamp: '2026-06-25T00:00:00.000Z',
				submissionId: 'direct-1',
				attemptId: 'attempt-1',
				outcome: 'completed' as const,
			};
			await executionStore.submissions.reserveSubmissionSettlement(
				{ submissionId: 'direct-1', attemptId: 'attempt-1' },
				{ recordId: record.id, record },
			);
			await stream.createStream('agents/echo/contract', { agentName: 'echo', instanceId: 'contract' });
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const base = {
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				submission: { submissionId: 'direct-1', attemptId: 'attempt-1' },
			};

			await expect(stream.append({ ...base, records: [record, userRecord('extra', 'extra')] })).rejects.toThrow();
			await expect(stream.append({ ...base, records: [{ ...record, outcome: 'failed' }] })).rejects.toThrow();
			await expect(stream.append({ ...base, submission: { submissionId: 'direct-1', attemptId: 'stale' }, records: [record] })).rejects.toThrow();
			await expect(stream.append({ ...base, records: [record] })).resolves.toEqual({ offset: '0000000000000000_0000000000000000' });
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
			const meta = await stream.getMeta('agents/echo/contract');
			if (!meta) throw new Error('Expected canonical stream metadata.');
			await snapshots.save('agents/echo/contract', {
				version: 1,
				reducerVersion: 1,
				streamOffset: '-1',
				streamIncarnation: meta.incarnation,
				state: {},
				createdAt: '2026-06-25T00:00:00.000Z',
			});

			await stream.delete('agents/echo/contract');

			expect(await stream.getMeta('agents/echo/contract')).toBeNull();
			expect(await snapshots.load('agents/echo/contract')).toBeNull();
		});
	});
}
