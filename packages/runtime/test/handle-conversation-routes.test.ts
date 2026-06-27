import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../src/conversation-records.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import {
	handleAgentConversationRead,
} from '../src/runtime/handle-conversation-routes.ts';

async function setup() {
	const adapter = sqlite();
	await adapter.migrate?.();
	const stores = await adapter.connect();
	const path = 'agents/assistant/instance-1';
	await stores.conversationStreamStore.createStream(path, {
		agentName: 'assistant',
		instanceId: 'instance-1',
	});
	const claim = await stores.conversationStreamStore.acquireProducer(path, 'producer-1');
	let sequence = claim.nextProducerSequence;
	const append = async (records: ConversationRecord[]) => {
		const result = await stores.conversationStreamStore.append({
			path,
			producerId: claim.producerId,
			producerEpoch: claim.producerEpoch,
			incarnation: claim.incarnation,
			producerSequence: sequence++,
			records,
		});
		return result.offset;
	};
	return { adapter, stores, path, append };
}

const scope = {
	v: 1 as const,
	conversationId: 'conversation-1',
	harness: 'default',
	session: 'default',
	timestamp: '2026-06-26T00:00:00.000Z',
};

describe('handleAgentConversationRead()', () => {
	it('returns one materialized snapshot through the physical tail', async () => {
		const { adapter, stores, path, append } = await setup();
		await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
			{
				...scope,
				id: 'user-1',
				type: 'user_message',
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'hello' }],
			},
		]);
		const physicalTail = await append([
			{
				...scope,
				id: 'created-2',
				type: 'conversation_created',
				kind: 'root',
				conversationId: 'conversation-2',
				session: 'other',
				affinityKey: 'affinity-2',
				createdAt: scope.timestamp,
			},
		]);

		const response = await handleAgentConversationRead({
			store: stores.conversationStreamStore,
			path,
			request: new Request('https://flue.test/agents/assistant/instance-1?view=history'),
		});
		const snapshot = await response.json();

		expect(snapshot).toMatchObject({
			type: 'conversation_snapshot',
			conversationId: 'conversation-1',
			offset: physicalTail,
			messages: [{ id: 'entry_user' }],
		});
		await adapter.close?.();
	});

	it('projects a whole physical batch and checkpoints only its batch offset', async () => {
		const { adapter, stores, path, append } = await setup();
		const start = await append([
			{
				...scope,
				id: 'created-1',
				type: 'conversation_created',
				kind: 'root',
				affinityKey: 'affinity-1',
				createdAt: scope.timestamp,
			},
		]);
		const tail = await append([
			{
				...scope,
				id: 'user-1',
				type: 'user_message',
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'hello' }],
			},
			{
				...scope,
				id: 'data-1',
				type: 'data',
				dataType: 'status',
				data: 'done',
			},
		]);

		const response = await handleAgentConversationRead({
			store: stores.conversationStreamStore,
			path,
			request: new Request(
				`https://flue.test/agents/assistant/instance-1?view=updates&offset=${encodeURIComponent(start)}`,
			),
		});
		const updates = await response.json();

		expect(updates).toHaveLength(2);
		expect(response.headers.get('Stream-Next-Offset')).toBe(tail);
		await adapter.close?.();
	});

	it('rejects arbitrary tail hydration', async () => {
		const { adapter, stores, path } = await setup();
		const response = await handleAgentConversationRead({
			store: stores.conversationStreamStore,
			path,
			request: new Request(
				'https://flue.test/agents/assistant/instance-1?view=history&tail=100',
			),
		});
		expect(response.status).toBe(400);
		await adapter.close?.();
	});
});
