import { describe, expect, it } from 'vitest';
import type { ConversationStreamChunk } from '../conversation-public.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import { toolResultEntryId } from '../conversation-reducer.ts';
import { InMemoryConversationStreamStore } from './conversation-stream-store.ts';
import { handleAgentConversationRead } from './handle-conversation-routes.ts';

const path = 'agents/echo/history';
const timestamp = '2026-01-01T00:00:00.000Z';
const usage = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const modelInfo = { api: 'openai-responses', provider: 'openai', model: 'test-model' } as const;

type Body = Record<string, unknown> & { messages: { id: string; parts: unknown[] }[] };

function envelope(id: string, submissionId?: string) {
	return {
		v: 1 as const,
		id,
		conversationId: 'conv_history',
		harness: 'default',
		session: 'default',
		timestamp,
		...(submissionId ? { submissionId, attemptId: `att_${submissionId}` } : {}),
	};
}

const created: ConversationRecord = {
	...envelope('record_created'),
	type: 'conversation_created',
	kind: 'root',
	affinityKey: 'affinity_history',
	createdAt: timestamp,
};

function userMessage(
	id: string,
	parentId: string | null,
	submissionId?: string,
): ConversationRecord {
	return {
		...envelope(`record_${id}`, submissionId),
		type: 'user_message',
		messageId: id,
		parentId,
		content: [{ type: 'text', text: id }],
	};
}

/** A conversation of `count` linear user messages `entry_m0..`. */
function linearRecords(count: number): ConversationRecord[] {
	const records = [created];
	for (let index = 0; index < count; index++) {
		records.push(userMessage(`entry_m${index}`, index === 0 ? null : `entry_m${index - 1}`));
	}
	return records;
}

async function createConversation(...batches: ConversationRecord[][]) {
	const store = new InMemoryConversationStreamStore();
	await store.createStream(path, { agentName: 'echo', instanceId: 'history' });
	const producer = await store.acquireProducer(path, 'coordinator');
	let sequence = 0;
	// Submission-owned records need their attempt's authorization, one
	// submission per append: split each batch into runs by submission.
	const append = async (records: ConversationRecord[]) => {
		const runs: ConversationRecord[][] = [];
		for (const record of records) {
			const run = runs.at(-1);
			if (run && run[0]?.submissionId === record.submissionId) run.push(record);
			else runs.push([record]);
		}
		for (const run of runs) {
			const submissionId = run[0]?.submissionId;
			await store.append({
				path,
				producerId: producer.producerId,
				producerEpoch: producer.producerEpoch,
				incarnation: producer.incarnation,
				producerSequence: sequence++,
				...(submissionId ? { submission: { submissionId, attemptId: `att_${submissionId}` } } : {}),
				records: run,
			});
		}
	};
	for (const batch of batches) await append(batch);
	return { store, append };
}

async function get(store: InMemoryConversationStreamStore, query: string) {
	const response = await handleAgentConversationRead({
		store,
		path,
		request: new Request(`https://flue.test/agents/echo/history?${query}`),
	});
	return { status: response.status, body: (await response.json()) as Body };
}

const history = (store: InMemoryConversationStreamStore, query = '') =>
	get(store, `view=history${query}`);
const q = (value: unknown) => encodeURIComponent(String(value));
const ids = (body: Body) => body.messages.map((message) => message.id);

describe('bounded history reads', () => {
	it('leaves the unbounded read unchanged', async () => {
		const { store } = await createConversation(linearRecords(4));
		const { status, body } = await history(store);
		expect(status).toBe(200);
		expect(ids(body)).toEqual(['entry_m0', 'entry_m1', 'entry_m2', 'entry_m3']);
		expect(body).not.toHaveProperty('before');
		expect(body).toHaveProperty('offset');
		expect(body).toHaveProperty('incarnation');
	});

	it('serves the newest window as a seedable snapshot, then older pages', async () => {
		const { store } = await createConversation(linearRecords(5));
		const full = await history(store);
		const head = await history(store, '&limit=2');
		expect(ids(head.body)).toEqual(['entry_m3', 'entry_m4']);
		expect(head.body).toMatchObject({
			offset: full.body.offset,
			incarnation: full.body.incarnation,
		});
		expect(head.body.before).toMatch(/^hc1\./);

		const older = await history(store, `&before=${q(head.body.before)}&limit=2`);
		expect(older.status).toBe(200);
		expect(ids(older.body)).toEqual(['entry_m1', 'entry_m2']);
		expect(older.body).not.toHaveProperty('offset');
		expect(older.body).not.toHaveProperty('incarnation');

		const oldest = await history(store, `&before=${q(older.body.before)}&limit=2`);
		expect(ids(oldest.body)).toEqual(['entry_m0']);
		expect(oldest.body).toMatchObject({ before: null });
	});

	it('re-reads from an anchor through the head with a stable cursor', async () => {
		const { store, append } = await createConversation(linearRecords(5));
		const head = await history(store, '&limit=3');
		await append([userMessage('entry_m5', 'entry_m4')]);
		const { body } = await history(store, `&from=${q(head.body.before)}`);
		expect(ids(body)).toEqual(['entry_m2', 'entry_m3', 'entry_m4', 'entry_m5']);
		expect(body.before).toBe(head.body.before);
		expect(body).toHaveProperty('offset');
	});

	it('rejects cursors from another stream generation even when message ids repeat', async () => {
		// Two generations with identical, deterministic message ids.
		const first = await createConversation(linearRecords(4));
		const second = await createConversation(linearRecords(4));
		const head = await history(first.store, '&limit=2');
		for (const query of [
			`&from=${q(head.body.before)}`,
			`&before=${q(head.body.before)}&limit=1`,
		]) {
			const gone = await history(second.store, query);
			expect(gone.status).toBe(410);
			expect(gone.body).toMatchObject({
				error: { type: 'history_cursor_not_found', meta: { cursor: head.body.before } },
			});
		}
	});

	it('rejects malformed bounds with 400', async () => {
		const { store } = await createConversation(linearRecords(2));
		expect((await history(store, '&limit=0')).status).toBe(400);
		// A raw message id is not a cursor.
		expect((await history(store, '&from=entry_m0')).status).toBe(400);
		expect((await get(store, 'view=updates&offset=-1&before=x')).status).toBe(400);
	});
});

describe('bounded windows around a live coalesced response', () => {
	// host user → completed host step → joined user → in-progress host
	// continuation. The continuation folds into the host's response message,
	// which sits *above* the joined message while still streaming.
	const busyJoin: ConversationRecord[] = [
		created,
		userMessage('entry_host', null, 'sub_host'),
		{
			...envelope('record_resp_started', 'sub_host'),
			type: 'assistant_message_started',
			messageId: 'entry_resp',
			parentId: 'entry_host',
			modelInfo,
		},
		{
			...envelope('record_resp_text', 'sub_host'),
			type: 'assistant_text_started',
			messageId: 'entry_resp',
			blockId: 'block_a',
			blockIndex: 0,
		},
		{
			...envelope('record_resp_delta', 'sub_host'),
			type: 'assistant_text_delta',
			messageId: 'entry_resp',
			blockId: 'block_a',
			sequence: 0,
			delta: 'Working on it.',
		},
		{
			...envelope('record_resp_text_done', 'sub_host'),
			type: 'assistant_text_completed',
			messageId: 'entry_resp',
			blockId: 'block_a',
			deltaCount: 1,
		},
		{
			...envelope('record_resp_done', 'sub_host'),
			type: 'assistant_message_completed',
			messageId: 'entry_resp',
			stopReason: 'stop',
			usage,
		},
		userMessage('entry_joined', 'entry_resp', 'sub_joined'),
		{
			...envelope('record_cont_started', 'sub_host'),
			type: 'assistant_message_started',
			messageId: 'entry_cont',
			parentId: 'entry_joined',
			modelInfo,
		},
	];

	const continuation: ConversationRecord[][] = [
		[
			{
				...envelope('record_cont_text', 'sub_host'),
				type: 'assistant_text_started',
				messageId: 'entry_cont',
				blockId: 'block_b',
				blockIndex: 0,
			},
			{
				...envelope('record_cont_delta', 'sub_host'),
				type: 'assistant_text_delta',
				messageId: 'entry_cont',
				blockId: 'block_b',
				sequence: 0,
				delta: ' Also handling your follow-up.',
			},
			{
				...envelope('record_cont_text_done', 'sub_host'),
				type: 'assistant_text_completed',
				messageId: 'entry_cont',
				blockId: 'block_b',
				deltaCount: 1,
			},
			{
				...envelope('record_cont_data', 'sub_host'),
				type: 'message_data_write',
				name: 'progress',
				data: { step: 1 },
			},
			{
				...envelope('record_cont_meta', 'sub_host'),
				type: 'message_metadata',
				metadata: { phase: 'tools' },
			},
			{
				...envelope('record_cont_tool', 'sub_host'),
				type: 'assistant_tool_call',
				messageId: 'entry_cont',
				blockId: 'block_c',
				blockIndex: 1,
				toolCallId: 'call_lookup',
				name: 'lookup',
				arguments: { q: 'x' },
			},
			{
				...envelope('record_cont_done', 'sub_host'),
				type: 'assistant_message_completed',
				messageId: 'entry_cont',
				stopReason: 'toolUse',
				usage,
			},
		],
		[
			{
				...envelope('record_outcome', 'sub_host'),
				type: 'tool_outcome',
				assistantMessageId: 'entry_cont',
				toolCallId: 'call_lookup',
				toolName: 'lookup',
				isError: false,
				content: [{ type: 'text', text: 'found' }],
			},
			{
				...envelope('record_committed', 'sub_host'),
				type: 'tool_results_committed',
				assistantMessageId: 'entry_cont',
				parentId: 'entry_cont',
				outcomeIds: ['record_outcome'],
			},
		],
		[
			{
				...envelope('record_settled_host', 'sub_host'),
				type: 'submission_settled',
				submissionId: 'sub_host',
				outcome: 'completed',
			},
			{
				...envelope('record_settled_joined', 'sub_joined'),
				type: 'submission_settled',
				submissionId: 'sub_joined',
				outcome: 'completed',
			},
		],
	];

	it('keeps the live response in a newest window smaller than the joined tail', async () => {
		const { store, append } = await createConversation(busyJoin);
		const full = await history(store);
		expect(ids(full.body)).toEqual(['entry_host', 'entry_resp', 'entry_joined']);

		const seed = await history(store, '&limit=1');
		// Closed suffix: the still-streaming response is pulled in above the joined message.
		expect(ids(seed.body)).toEqual(['entry_resp', 'entry_joined']);
		const held = new Set(ids(seed.body));
		const toolCalls = new Set<string>();

		for (const batch of continuation) await append(batch);
		const updates = await get(store, `view=updates&offset=${q(seed.body.offset)}`);
		const chunks = updates.body as unknown as ConversationStreamChunk[];
		const kinds = new Set<string>();
		for (const chunk of chunks) {
			kinds.add(chunk.type);
			if (chunk.type === 'message-appended') held.add(chunk.message.id);
			else if (chunk.type === 'tool-input') {
				expect(held).toContain(chunk.messageId);
				toolCalls.add(chunk.toolCallId);
			} else if (chunk.type === 'tool-output' || chunk.type === 'tool-output-error') {
				expect(toolCalls).toContain(chunk.toolCallId);
			} else if ('messageId' in chunk) {
				// Every chunk addressed to a message targets one the window holds.
				expect(held).toContain(chunk.messageId);
			}
		}
		expect(kinds).toEqual(
			new Set([
				'stream-checkpoint',
				'message-delta',
				'data-part',
				'message-metadata',
				'tool-input',
				'message-completed',
				'tool-output',
				'submission-settled',
			]),
		);

		// Settled: the response no longer pins the window.
		expect(ids((await history(store, '&limit=1')).body)).toEqual(['entry_joined']);
	});

	it('cuts conversation-reset snapshots to the anchored window server-side', async () => {
		const { store, append } = await createConversation(busyJoin, ...continuation);
		const seed = await history(store, '&limit=2');
		const [older] = ids(seed.body);
		await append([
			{
				...envelope('record_compaction'),
				type: 'compaction',
				entryId: 'entry_compaction',
				parentId: toolResultEntryId('entry_cont', 'call_lookup'),
				summary: 'Summary.',
				firstKeptEntryId: 'entry_joined',
				sourceLeafId: toolResultEntryId('entry_cont', 'call_lookup'),
				tokensBefore: 100,
			},
		]);
		const resetOf = (body: Body) =>
			(body as unknown as ConversationStreamChunk[]).find(
				(chunk) => chunk.type === 'conversation-reset',
			);

		const bounded = await get(
			store,
			`view=updates&offset=${q(seed.body.offset)}&from=${q(seed.body.before)}&limit=2`,
		);
		const reset = resetOf(bounded.body);
		expect(reset?.type).toBe('conversation-reset');
		if (reset?.type !== 'conversation-reset') return;
		expect(reset.snapshot.messages[0]?.id).toBe(older);
		expect(reset.snapshot.messages).toHaveLength(seed.body.messages.length);
		expect(reset.snapshot.before).toBe(seed.body.before);

		// Unbounded updates keep today's whole-transcript reset.
		const unbounded = await get(store, `view=updates&offset=${q(seed.body.offset)}`);
		const whole = resetOf(unbounded.body);
		if (whole?.type !== 'conversation-reset') throw new Error('expected a reset');
		expect(whole.snapshot.messages.length).toBeGreaterThan(seed.body.messages.length);
		expect(whole.snapshot).not.toHaveProperty('before');
	});
});
