/**
 * Bounded history end to end: the SDK client against the real runtime route
 * handler and an in-memory conversation stream (no network).
 */
import {
	handleAgentConversationRead,
	InMemoryConversationStreamStore,
} from '@flue/runtime/internal';
import { describe, expect, it } from 'vitest';
import { createFlueClient } from '../client.ts';
import { FlueApiError } from '../http.ts';

const path = 'agents/echo/history';
type Records = Parameters<InMemoryConversationStreamStore['append']>[0]['records'];

function linearRecords(count: number): Records {
	const envelope = (id: string) => ({
		v: 1 as const,
		id,
		conversationId: 'conv_history',
		harness: 'default',
		session: 'default',
		timestamp: '2026-01-01T00:00:00.000Z',
	});
	return [
		{
			...envelope('record_created'),
			type: 'conversation_created',
			kind: 'root',
			affinityKey: 'affinity',
			createdAt: '2026-01-01T00:00:00.000Z',
		},
		...Array.from({ length: count }, (_, index) => ({
			...envelope(`record_${index}`),
			type: 'user_message' as const,
			messageId: `entry_m${index}`,
			parentId: index === 0 ? null : `entry_m${index - 1}`,
			content: [{ type: 'text' as const, text: `message ${index}` }],
		})),
	];
}

/**
 * A fresh stream generation holding `count` messages with deterministic ids,
 * appended over `batches` batches (so generations can differ in length).
 */
async function generation(count: number, batches = 1): Promise<InMemoryConversationStreamStore> {
	const store = new InMemoryConversationStreamStore();
	await store.createStream(path, { agentName: 'echo', instanceId: 'history' });
	const producer = await store.acquireProducer(path, 'coordinator');
	const records = linearRecords(count);
	const size = Math.ceil(records.length / batches);
	for (let batch = 0; batch < batches; batch++) {
		await store.append({
			path,
			producerId: producer.producerId,
			producerEpoch: producer.producerEpoch,
			incarnation: producer.incarnation,
			producerSequence: batch,
			records: records.slice(batch * size, (batch + 1) * size),
		});
	}
	return store;
}

/** A client whose "server" can be swapped to another generation, dropping live connections. */
function connect(initial: InMemoryConversationStreamStore) {
	let store = initial;
	const pending = new Set<(error: Error) => void>();
	const client = createFlueClient({
		url: 'https://flue.test/agents/echo/history',
		fetch: (input, init) =>
			new Promise<Response>((resolve, reject) => {
				pending.add(reject);
				const request = new Request(String(input), { signal: init?.signal ?? null });
				handleAgentConversationRead({ store, path, request }).then(resolve, reject);
			}),
	});
	return {
		client,
		swap(next: InMemoryConversationStreamStore) {
			store = next;
			for (const reject of pending) reject(new TypeError('network connection lost'));
			pending.clear();
		},
	};
}

async function until(check: () => boolean, timeoutMs = 8_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out waiting for the observation');
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

describe('bounded history against the runtime', () => {
	it('pages backward, and rejects a cursor after the stream is regrown with the same ids', async () => {
		const server = connect(await generation(6));
		const head = await server.client.history({ limit: 2 });
		expect(head.messages.map((m) => m.id)).toEqual(['entry_m4', 'entry_m5']);
		const cursor = head.before;
		if (typeof cursor !== 'string') throw new Error('expected an older-page cursor');
		const page = await server.client.historyBefore(cursor, { limit: 2 });
		expect(page.messages.map((m) => m.id)).toEqual(['entry_m2', 'entry_m3']);

		server.swap(await generation(6));
		const error = await server.client.historyBefore(cursor, { limit: 2 }).catch((e) => e);
		expect(error).toBeInstanceOf(FlueApiError);
		expect((error as FlueApiError).status).toBe(410);
	});

	it('re-bases a bounded observation when the stream is regrown while disconnected', async () => {
		// The first generation is longer (more batches) than its replacement, so
		// the held offset is gone after the swap: the observation re-hydrates
		// with its anchored cursor, which the regrown generation rejects (410)
		// even though it contains the same message ids.
		const server = connect(await generation(5, 3));
		const observation = server.client.observe({ limit: 2, live: 'long-poll' });
		observation.subscribe(() => {});
		try {
			await until(() => observation.getSnapshot().phase === 'live');
			const first = observation.getSnapshot().conversation;
			expect(first?.messages.map((m) => m.id)).toEqual(['entry_m3', 'entry_m4']);

			// Same deterministic ids, different generation, more messages.
			server.swap(await generation(7));
			await until(() => observation.getSnapshot().conversation?.before !== first?.before);
			const next = observation.getSnapshot().conversation;
			expect(next?.messages.map((m) => m.id)).toEqual(['entry_m5', 'entry_m6']);
			expect(typeof next?.before).toBe('string');
		} finally {
			observation.close();
		}
	}, 15_000);
});
