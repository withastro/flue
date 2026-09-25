import { describe, expect, it } from 'vitest';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from './conversation-public.ts';
import type { ConversationRecord } from './conversation-records.ts';
import {
	createReducedInstanceState,
	reduceConversationRecords,
	toolResultEntryId,
} from './conversation-reducer.ts';

const usage = {
	input: 10,
	output: 10,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 20,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const modelInfo = { api: 'openai-responses', provider: 'openai', model: 'test-model' };

/** Distinct, strictly increasing capture times so each assertion pins its source record. */
const at = (second: number) => `2026-01-01T00:00:${String(second).padStart(2, '0')}.000Z`;

const base = {
	v: 1 as const,
	conversationId: 'conv_ts',
	harness: 'default',
	session: 'default',
};

const created: ConversationRecord = {
	...base,
	timestamp: at(0),
	id: 'record_created',
	type: 'conversation_created',
	kind: 'root',
	affinityKey: 'affinity_ts',
	createdAt: at(0),
};
const user: ConversationRecord = {
	...base,
	timestamp: at(1),
	submissionId: 'sub_1',
	id: 'record_user',
	type: 'user_message',
	messageId: 'entry_user',
	parentId: null,
	content: [{ type: 'text', text: 'Look it up.' }],
};
// Step 1: a tool call, then its committed result.
const step1: ConversationRecord[] = [
	{
		...base,
		timestamp: at(2),
		submissionId: 'sub_1',
		id: 'record_step1_started',
		type: 'assistant_message_started',
		messageId: 'entry_step1',
		parentId: 'entry_user',
		modelInfo,
	},
	{
		...base,
		timestamp: at(3),
		submissionId: 'sub_1',
		id: 'record_step1_tool',
		type: 'assistant_tool_call',
		messageId: 'entry_step1',
		blockId: 'block_tool',
		blockIndex: 0,
		toolCallId: 'call_1',
		name: 'lookup',
		arguments: { q: 'x' },
	},
	{
		...base,
		timestamp: at(4),
		submissionId: 'sub_1',
		id: 'record_step1_completed',
		type: 'assistant_message_completed',
		messageId: 'entry_step1',
		stopReason: 'toolUse',
		usage,
	},
	{
		...base,
		timestamp: at(5),
		submissionId: 'sub_1',
		id: 'record_outcome',
		type: 'tool_outcome',
		assistantMessageId: 'entry_step1',
		toolCallId: 'call_1',
		toolName: 'lookup',
		isError: false,
		content: [{ type: 'text', text: 'found' }],
	},
	{
		...base,
		timestamp: at(6),
		submissionId: 'sub_1',
		id: 'record_committed',
		type: 'tool_results_committed',
		assistantMessageId: 'entry_step1',
		parentId: 'entry_step1',
		outcomeIds: ['record_outcome'],
	},
];
// Step 2 of the same submission: merges into step 1's response message.
const step2: ConversationRecord[] = [
	{
		...base,
		timestamp: at(7),
		submissionId: 'sub_1',
		id: 'record_step2_started',
		type: 'assistant_message_started',
		messageId: 'entry_step2',
		parentId: toolResultEntryId('entry_step1', 'call_1'),
		modelInfo,
	},
	{
		...base,
		timestamp: at(8),
		submissionId: 'sub_1',
		id: 'record_step2_text_started',
		type: 'assistant_text_started',
		messageId: 'entry_step2',
		blockId: 'block_text',
		blockIndex: 0,
	},
	{
		...base,
		timestamp: at(8),
		submissionId: 'sub_1',
		id: 'record_step2_delta',
		type: 'assistant_text_delta',
		messageId: 'entry_step2',
		blockId: 'block_text',
		sequence: 0,
		delta: 'Done.',
	},
	{
		...base,
		timestamp: at(9),
		submissionId: 'sub_1',
		id: 'record_step2_text_completed',
		type: 'assistant_text_completed',
		messageId: 'entry_step2',
		blockId: 'block_text',
		deltaCount: 1,
	},
	{
		...base,
		timestamp: at(9),
		submissionId: 'sub_1',
		id: 'record_step2_completed',
		type: 'assistant_message_completed',
		messageId: 'entry_step2',
		stopReason: 'stop',
		usage,
	},
];
const settled: ConversationRecord = {
	...base,
	timestamp: at(10),
	submissionId: 'sub_1',
	id: 'record_settled',
	type: 'submission_settled',
	outcome: 'completed',
};
const signal: ConversationRecord = {
	...base,
	timestamp: at(11),
	submissionId: 'sub_2',
	id: 'record_signal',
	type: 'signal',
	messageId: 'entry_signal',
	parentId: 'entry_step2',
	signalType: 'dispatch',
	content: 'Ping from elsewhere.',
};
const inProgressStarted: ConversationRecord = {
	...base,
	timestamp: at(12),
	submissionId: 'sub_2',
	id: 'record_live_started',
	type: 'assistant_message_started',
	messageId: 'entry_live',
	parentId: 'entry_signal',
	modelInfo,
};

function reduce(records: ConversationRecord[]) {
	return reduceConversationRecords(createReducedInstanceState(), records);
}

const allRecords = [created, user, ...step1, ...step2, settled, signal, inProgressStarted];

describe('server-authored message timestamps', () => {
	it('stamps every projected message with its record capture time', () => {
		const snapshot = projectAgentConversationSnapshot(reduce(allRecords));
		expect(snapshot?.messages.map(({ id, role, timestamp }) => ({ id, role, timestamp }))).toEqual([
			{ id: 'entry_user', role: 'user', timestamp: at(1) },
			// Merged multi-step response keeps the first step's start time.
			{ id: 'entry_step1', role: 'assistant', timestamp: at(2) },
			{ id: 'entry_signal', role: 'system', timestamp: at(11) },
			// In-progress shell carries its `assistant_message_started` time.
			{ id: 'entry_live', role: 'assistant', timestamp: at(12) },
		]);
		expect(snapshot?.messages[1]?.parts).toHaveLength(2);
		expect(snapshot?.settlements).toEqual([
			{ submissionId: 'sub_1', outcome: 'completed', timestamp: at(10) },
		]);
	});

	it('stamps message-appended bodies with the same time the snapshot projects', () => {
		const snapshot = projectAgentConversationSnapshot(reduce(allRecords));
		const snapshotTime = (id: string) =>
			snapshot?.messages.find((message) => message.id === id)?.timestamp;

		const cases: Array<{ before: ConversationRecord[]; record: ConversationRecord }> = [
			{ before: [created], record: user },
			{ before: [created, user, ...step1, ...step2, settled], record: signal },
		];
		for (const { before, record } of cases) {
			const [chunk] = projectAgentConversationBatch({
				state: reduce([...before, record]),
				previousState: reduce(before),
				records: [record],
				batchOrdinal: 1,
			});
			expect(chunk?.type).toBe('message-appended');
			if (chunk?.type !== 'message-appended') continue;
			expect(chunk.message.timestamp).toBe(record.timestamp);
			expect(chunk.message.timestamp).toBe(snapshotTime(chunk.message.id));
		}
	});

	it('streams a later step under the first step’s response id and start time', () => {
		const before = [created, user, ...step1];
		const started = step2[0] as ConversationRecord;
		const [chunk] = projectAgentConversationBatch({
			state: reduce([...before, started]),
			previousState: reduce(before),
			records: [started],
			batchOrdinal: 1,
		});
		// The continuation's `message-started` addresses the open response; the
		// SDK treats it as a no-op, so the response keeps step 1's timestamp.
		expect(chunk).toMatchObject({ type: 'message-started', messageId: 'entry_step1' });
	});
});
