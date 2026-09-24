import { describe, expect, it } from 'vitest';
import type { ConversationRecord } from '../conversation-records.ts';
import { InMemoryConversationStreamStore } from './conversation-stream-store.ts';
import { handleAgentConversationRead } from './handle-conversation-routes.ts';

const path = 'agents/echo/history';
const timestamp = '2026-01-01T00:00:00.000Z';
const envelope = {
	v: 1 as const,
	conversationId: 'conv_history',
	harness: 'default',
	session: 'default',
	timestamp,
};

async function conversationWith(count: number): Promise<InMemoryConversationStreamStore> {
	const store = new InMemoryConversationStreamStore();
	await store.createStream(path, { agentName: 'echo', instanceId: 'history' });
	const producer = await store.acquireProducer(path, 'coordinator');
	const records: ConversationRecord[] = [
		{
			...envelope,
			id: 'record_created',
			type: 'conversation_created',
			kind: 'root',
			affinityKey: 'affinity_history',
			createdAt: timestamp,
		},
	];
	for (let index = 0; index < count; index++) {
		records.push({
			...envelope,
			id: `record_${index}`,
			type: 'user_message',
			messageId: `entry_m${index}`,
			parentId: index === 0 ? null : `entry_m${index - 1}`,
			content: [{ type: 'text', text: `message ${index}` }],
		});
	}
	await store.append({
		path,
		producerId: producer.producerId,
		producerEpoch: producer.producerEpoch,
		incarnation: producer.incarnation,
		producerSequence: 0,
		records,
	});
	return store;
}

async function read(store: InMemoryConversationStreamStore, query: string) {
	const response = await handleAgentConversationRead({
		store,
		path,
		request: new Request(`https://flue.test/agents/echo/history?view=history${query}`),
	});
	return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

const ids = (body: Record<string, unknown>) =>
	(body.messages as { id: string }[]).map((message) => message.id);

describe('bounded history reads', () => {
	it('leaves the unbounded read unchanged', async () => {
		const store = await conversationWith(4);
		const { status, body } = await read(store, '');
		expect(status).toBe(200);
		expect(ids(body)).toEqual(['entry_m0', 'entry_m1', 'entry_m2', 'entry_m3']);
		expect(body).not.toHaveProperty('before');
		expect(body).toHaveProperty('offset');
		expect(body).toHaveProperty('incarnation');
	});

	it('serves the newest window as a seedable snapshot, then older pages', async () => {
		const store = await conversationWith(5);
		const full = await read(store, '');
		const head = await read(store, '&limit=2');
		expect(ids(head.body)).toEqual(['entry_m3', 'entry_m4']);
		expect(head.body).toMatchObject({
			offset: full.body.offset,
			incarnation: full.body.incarnation,
			before: 'entry_m3',
		});

		const older = await read(store, `&before=${head.body.before}&limit=2`);
		expect(older.status).toBe(200);
		expect(ids(older.body)).toEqual(['entry_m1', 'entry_m2']);
		expect(older.body).toMatchObject({ before: 'entry_m1' });
		expect(older.body).not.toHaveProperty('offset');
		expect(older.body).not.toHaveProperty('incarnation');

		const oldest = await read(store, `&before=${older.body.before}&limit=2`);
		expect(ids(oldest.body)).toEqual(['entry_m0']);
		expect(oldest.body).toMatchObject({ before: null });
	});

	it('re-reads from an anchor through the head', async () => {
		const store = await conversationWith(5);
		const { body } = await read(store, '&from=entry_m2');
		expect(ids(body)).toEqual(['entry_m2', 'entry_m3', 'entry_m4']);
		expect(body).toMatchObject({ before: 'entry_m2' });
		expect(body).toHaveProperty('offset');
	});

	it('rejects an unknown cursor with 410 and malformed bounds with 400', async () => {
		const store = await conversationWith(2);
		const gone = await read(store, '&from=missing');
		expect(gone.status).toBe(410);
		expect(gone.body).toMatchObject({ error: { type: 'history_cursor_not_found' } });
		expect((await read(store, '&before=missing')).status).toBe(410);
		expect((await read(store, '&limit=0')).status).toBe(400);
		expect((await read(store, '&from=entry_m0&before=entry_m1')).status).toBe(400);
	});
});
