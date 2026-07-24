import { afterEach, describe, expect, it } from 'vitest';
import type { AgentSubmissionStore } from '../agent-execution-store.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import type { ConversationStreamStore } from '../runtime/conversation-stream-store.ts';

export interface ConversationStreamStoreContractBackend {
	create():
		| {
				stream: ConversationStreamStore;
				submissionStore?: AgentSubmissionStore;
		  }
		| Promise<{
				stream: ConversationStreamStore;
				submissionStore?: AgentSubmissionStore;
		  }>;
	cleanup?(): void | Promise<void>;
}

function userRecord(id: string, messageId: string, text = messageId): ConversationRecord {
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
		content: [{ type: 'text', text }],
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
	submissionStore: AgentSubmissionStore,
	submissionId: string,
	attemptId: string,
	agent = 'echo',
): Promise<void> {
	await submissionStore.admitDirect({
		kind: 'direct',
		submissionId,
		agent,
		id: 'contract',
		message: { kind: 'user', body: 'Hello' },
		acceptedAt: '2026-06-25T00:00:00.000Z',
	});
	await submissionStore.markSubmissionCanonicalReady(submissionId);
	await submissionStore.claimSubmission({
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
		async function create() {
			return backend.create();
		}

		afterEach(async () => {
			await backend.cleanup?.();
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
			expect([first, second]).toContainEqual(
				(await stream.getMeta('agents/echo/contract'))?.identity,
			);
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

		it('assigns one indivisible offset to a multi-record batch', async () => {
			// The whole batch must be one atomic offset unit: both records live at a
			// single offset and resuming strictly after it returns nothing. A store
			// that split a batch across per-record offsets — the partial-application
			// hazard the append atomicity contract forbids — would fail this, because
			// ensureChildConversation() relies on the child `conversation_created` and
			// parent `child_session_retained` landing together or not at all.
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

			const after = await stream.read('agents/echo/contract', { offset: result.offset });
			expect(after.batches).toEqual([]);
			expect(after.upToDate).toBe(true);
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

		it('round-trips a batch larger than a backend cell-size cap', async () => {
			// 2.5MB of text in one record: past Cloudflare Durable Object
			// SQLite's ~2MB value cap, under MongoDB's 16MB document cap and
			// MySQL's default max_allowed_packet.
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const record = userRecord('record_large', 'entry_large', 'x'.repeat(2_500_000));
			const result = await stream.append({
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				records: [record],
			});

			const read = await stream.read('agents/echo/contract');
			expect(read.batches).toEqual([{ offset: result.offset, records: [record] }]);
			expect(read.nextOffset).toBe(result.offset);
			expect(read.upToDate).toBe(true);

			const second = await stream.append({
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 1,
				records: [userRecord('record_after', 'entry_after')],
			});
			expect(await stream.read('agents/echo/contract', { offset: result.offset })).toMatchObject({
				batches: [{ offset: second.offset, records: [{ id: 'record_after' }] }],
				upToDate: true,
			});
		});

		it('returns the original offset for an exact oversized retry', async () => {
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
				records: [userRecord('record_large', 'entry_large', 'x'.repeat(2_500_000))],
			};

			expect(await stream.append(input)).toEqual(await stream.append(input));
			expect((await stream.read('agents/echo/contract')).batches).toHaveLength(1);
		});

		it('rejects a conflicting oversized retry without advancing the stream', async () => {
			// Same producer sequence and same serialized length, one character
			// different: only a full-content compare can detect the conflict.
			const { stream } = await create();
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const text = 'x'.repeat(2_500_000);
			const base = {
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
			};
			await stream.append({
				...base,
				records: [userRecord('record_large', 'entry_large', text)],
			});

			await expect(
				stream.append({
					...base,
					records: [userRecord('record_large', 'entry_large', `${text.slice(0, -1)}y`)],
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
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			await submissionStore.admitDirect({
				kind: 'direct',
				submissionId: 'direct-1',
				agent: 'echo',
				id: 'contract',
				message: { kind: 'user', body: 'Hello' },
				acceptedAt: '2026-06-25T00:00:00.000Z',
			});
			await submissionStore.markSubmissionCanonicalReady('direct-1');
			await submissionStore.claimSubmission({
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
			await submissionStore.reserveSubmissionSettlement(
				{ submissionId: 'direct-1', attemptId: 'attempt-1' },
				{ recordId: record.id, record },
			);
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const base = {
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: 0,
				submission: { submissionId: 'direct-1', attemptId: 'attempt-1' },
			};

			await expect(
				stream.append({ ...base, records: [record, userRecord('extra', 'extra')] }),
			).rejects.toThrow();
			await expect(
				stream.append({ ...base, records: [{ ...record, outcome: 'failed' }] }),
			).rejects.toThrow();
			await expect(
				stream.append({
					...base,
					submission: { submissionId: 'direct-1', attemptId: 'stale' },
					records: [record],
				}),
			).rejects.toThrow();
			await expect(stream.append({ ...base, records: [record] })).resolves.toEqual({
				offset: '0000000000000000_0000000000000000',
			});
		});

		it('authorizes a submission-owned append for the running claimed attempt', async () => {
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			await claimContractSubmission(submissionStore, 'direct-1', 'attempt-1');
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
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

		it('rejects a submission-owned append from another agent sharing the instance id', async () => {
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			// The submission belongs to other-agent/contract; the stream belongs to
			// echo/contract. Same instance id, different agent — the ownership
			// fence must compare the FULL (agent, id) address, not the id alone.
			await claimContractSubmission(submissionStore, 'direct-1', 'attempt-1', 'other-agent');
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
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
			).rejects.toThrow();
			expect((await stream.read('agents/echo/contract')).batches).toHaveLength(0);
		});

		it('rejects a submission-owned append from a stale attempt', async () => {
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			await claimContractSubmission(submissionStore, 'direct-1', 'attempt-1');
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
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
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
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

		it('authorizes a host append for a delivery it claimed for a turn-boundary join', async () => {
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			await claimContractSubmission(submissionStore, 'host-1', 'attempt-1');
			await submissionStore.admitDirect({
				kind: 'direct',
				submissionId: 'delivery-1',
				agent: 'echo',
				id: 'contract',
				message: { kind: 'user', body: 'While busy' },
				acceptedAt: '2026-06-25T00:00:01.000Z',
			});
			await submissionStore.markSubmissionCanonicalReady('delivery-1');
			const claimed = await submissionStore.claimJoinableSubmissions(
				{ submissionId: 'host-1', attemptId: 'attempt-1' },
				'echo',
			);
			expect(claimed).toMatchObject([{ submissionId: 'delivery-1', status: 'joining' }]);
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');
			const base = {
				path: 'agents/echo/contract',
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				submission: { submissionId: 'host-1', attemptId: 'attempt-1' },
			};

			// `joining` (claimed, input not yet confirmed): the host attempt
			// writes the delivery's input record under its own authority.
			await expect(
				stream.append({
					...base,
					producerSequence: 0,
					records: [ownedUserRecord('record_1', 'entry_1', 'delivery-1', 'attempt-1')],
				}),
			).resolves.toMatchObject({ offset: expect.any(String) });

			// `joined` (confirmed): adoption records still append under the host.
			await submissionStore.finalizeJoinedSubmission(
				{ submissionId: 'host-1', attemptId: 'attempt-1' },
				'delivery-1',
			);
			await expect(
				stream.append({
					...base,
					producerSequence: 1,
					records: [ownedUserRecord('record_2', 'entry_2', 'delivery-1', 'attempt-1')],
				}),
			).resolves.toMatchObject({ offset: expect.any(String) });
		});

		it('rejects a host append for a foreign submission it has not claimed', async () => {
			const { stream, submissionStore } = await create();
			if (!submissionStore) return;
			await claimContractSubmission(submissionStore, 'host-1', 'attempt-1');
			// The delivery is queued and canonical-ready but never claimed for a
			// join, so its records are foreign to the host attempt.
			await submissionStore.admitDirect({
				kind: 'direct',
				submissionId: 'delivery-1',
				agent: 'echo',
				id: 'contract',
				message: { kind: 'user', body: 'While busy' },
				acceptedAt: '2026-06-25T00:00:01.000Z',
			});
			await submissionStore.markSubmissionCanonicalReady('delivery-1');
			await stream.createStream('agents/echo/contract', {
				agentName: 'echo',
				instanceId: 'contract',
			});
			const producer = await stream.acquireProducer('agents/echo/contract', 'coordinator');

			await expect(
				stream.append({
					path: 'agents/echo/contract',
					producerId: producer.producerId,
					producerEpoch: producer.producerEpoch,
					incarnation: producer.incarnation,
					producerSequence: 0,
					submission: { submissionId: 'host-1', attemptId: 'attempt-1' },
					records: [ownedUserRecord('record_1', 'entry_1', 'delivery-1', 'attempt-1')],
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
	});
}
