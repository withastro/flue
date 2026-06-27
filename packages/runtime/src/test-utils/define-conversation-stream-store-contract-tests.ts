import { afterEach, describe, expect, it } from 'vitest';
import type { AgentExecutionStore } from '../agent-execution-store.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';

export interface ConversationStreamStoreContractBackend {
	create():
		| {
				stream: ConversationStreamStore;
				executionStore?: AgentExecutionStore;
		  }
		| Promise<{
				stream: ConversationStreamStore;
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

function ownedUserRecord(
	id: string,
	messageId: string,
	submissionId: string,
	attemptId: string,
): ConversationRecord {
	return { ...userRecord(id, messageId), submissionId, attemptId };
}

async function claimContractSubmission(
	executionStore: AgentExecutionStore,
	submissionId: string,
	attemptId: string,
): Promise<void> {
	await executionStore.submissions.admitDirect({
		kind: 'direct',
		submissionId,
		agent: 'echo',
		id: 'contract',
		payload: { message: 'Hello' },
		acceptedAt: '2026-06-25T00:00:00.000Z',
	});
	await executionStore.submissions.markSubmissionCanonicalReady(submissionId);
	await executionStore.submissions.claimSubmission({
		submissionId,
		attemptId,
		ownerId: 'coordinator',
		leaseExpiresAt: Date.now() + 30_000,
	});
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

		it('creates one stream when exact identities race', async () => {
			const { stream } = await create();
			const identity = { agentName: 'echo', instanceId: 'contract' };

			await expect(
				Promise.all([
					stream.createStream('agents/echo/contract', identity),
					stream.createStream('agents/echo/contract', identity),
				]),
			).resolves.toEqual([undefined, undefined]);
			expect(await stream.getMeta('agents/echo/contract')).toMatchObject({ identity });
		});

		it('retains one identity when conflicting creates race', async () => {
			const { stream } = await create();
			const first = { agentName: 'echo', instanceId: 'first' };
			const second = { agentName: 'echo', instanceId: 'second' };

			const results = await Promise.allSettled([
				stream.createStream('agents/echo/contract', first),
				stream.createStream('agents/echo/contract', second),
			]);

			expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
			expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
			expect([first, second]).toContainEqual((await stream.getMeta('agents/echo/contract'))?.identity);
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

		it('rejects an exact retry after producer reacquisition', async () => {
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
			await stream.append(input);
			await stream.acquireProducer('agents/echo/contract', 'coordinator');

			await expect(stream.append(input)).rejects.toThrow();
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

		it('authorizes a submission-owned append for the running claimed attempt', async () => {
			const { stream, executionStore } = await create();
			if (!executionStore) return;
			await claimContractSubmission(executionStore, 'direct-1', 'attempt-1');
			await stream.createStream('agents/echo/contract', { agentName: 'echo', instanceId: 'contract' });
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');

			await expect(
				stream.append({
					path: 'agents/echo/contract',
					producerId: producer.producerId,
					producerEpoch: producer.producerEpoch,
					incarnation: producer.incarnation,
					producerSequence: 0,
					submission: { submissionId: 'direct-1', attemptId: 'attempt-1' },
					records: [ownedUserRecord('record_1', 'entry_1', 'direct-1', 'attempt-1')],
				}),
			).resolves.toMatchObject({ offset: expect.any(String) });
		});

		it('rejects a submission-owned append from a stale attempt', async () => {
			const { stream, executionStore } = await create();
			if (!executionStore) return;
			await claimContractSubmission(executionStore, 'direct-1', 'attempt-1');
			await stream.createStream('agents/echo/contract', { agentName: 'echo', instanceId: 'contract' });
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');

			// In-record ownership matches the (stale) attempt, but the submission row
			// still records attempt-1 as owner, so the store must reject.
			await expect(
				stream.append({
					path: 'agents/echo/contract',
					producerId: producer.producerId,
					producerEpoch: producer.producerEpoch,
					incarnation: producer.incarnation,
					producerSequence: 0,
					submission: { submissionId: 'direct-1', attemptId: 'attempt-2' },
					records: [ownedUserRecord('record_1', 'entry_1', 'direct-1', 'attempt-2')],
				}),
			).rejects.toThrow();
			expect((await stream.read('agents/echo/contract')).batches).toHaveLength(0);
		});

		it('rejects a submission-owned append for an unknown submission', async () => {
			const { stream, executionStore } = await create();
			if (!executionStore) return;
			await stream.createStream('agents/echo/contract', { agentName: 'echo', instanceId: 'contract' });
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');

			await expect(
				stream.append({
					path: 'agents/echo/contract',
					producerId: producer.producerId,
					producerEpoch: producer.producerEpoch,
					incarnation: producer.incarnation,
					producerSequence: 0,
					submission: { submissionId: 'ghost', attemptId: 'attempt-1' },
					records: [ownedUserRecord('record_1', 'entry_1', 'ghost', 'attempt-1')],
				}),
			).rejects.toThrow();
			expect((await stream.read('agents/echo/contract')).batches).toHaveLength(0);
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

		it('deletes the physical stream', async () => {
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});

			await stream.delete('agents/echo/contract');

			expect(await stream.getMeta('agents/echo/contract')).toBeNull();
		});
	});
}
