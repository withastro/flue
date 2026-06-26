import { describe, expect, it } from 'vitest';
import {
	classifyConversationSubmission,
	projectConversationUi,
} from '../src/conversation-projections.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
import {
	applyConversationRecord,
	buildConversationContext,
	createReducedInstanceState,
	getActiveConversationPath,
	reduceConversationRecords,
} from '../src/conversation-reducer.ts';
import { ConversationRecordInvariantError } from '../src/errors.ts';

const scope = {
	v: 1 as const,
	conversationId: 'conv_01',
	harness: 'default',
	session: 'default',
};

function required<T>(value: T | undefined): T {
	if (value === undefined) throw new Error('Expected fixture value.');
	return value;
}

const usage = {
	input: 10,
	output: 2,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 12,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function canonicalConversation(): ConversationRecord[] {
	return [
		{
			...scope,
			id: 'record_created',
			type: 'conversation_created',
			timestamp: '2026-06-25T00:00:00.000Z',
			affinityKey: 'aff_01',
			createdAt: '2026-06-25T00:00:00.000Z',
		},
		{
			...scope,
			id: 'record_user',
			type: 'user_message',
			timestamp: '2026-06-25T00:00:01.000Z',
			messageId: 'entry_user',
			parentId: null,
			content: [{ type: 'text', text: 'Hello' }],
		},
		{
			...scope,
			id: 'record_assistant_start',
			type: 'assistant_message_started',
			timestamp: '2026-06-25T00:00:02.000Z',
			messageId: 'entry_assistant',
			parentId: 'entry_user',
			turnId: 'turn_01',
			modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
		},
		{
			...scope,
			id: 'record_text_start',
			type: 'assistant_text_started',
			timestamp: '2026-06-25T00:00:02.100Z',
			messageId: 'entry_assistant',
			blockId: 'block_text',
			blockIndex: 0,
		},
		{
			...scope,
			id: 'record_text_delta_0',
			type: 'assistant_text_delta',
			timestamp: '2026-06-25T00:00:02.200Z',
			messageId: 'entry_assistant',
			blockId: 'block_text',
			sequence: 0,
			delta: 'Hi ',
		},
		{
			...scope,
			id: 'record_text_delta_1',
			type: 'assistant_text_delta',
			timestamp: '2026-06-25T00:00:02.300Z',
			messageId: 'entry_assistant',
			blockId: 'block_text',
			sequence: 1,
			delta: 'there',
		},
		{
			...scope,
			id: 'record_text_complete',
			type: 'assistant_text_completed',
			timestamp: '2026-06-25T00:00:02.400Z',
			messageId: 'entry_assistant',
			blockId: 'block_text',
			deltaCount: 2,
		},
		{
			...scope,
			id: 'record_assistant_complete',
			type: 'assistant_message_completed',
			timestamp: '2026-06-25T00:00:02.500Z',
			messageId: 'entry_assistant',
			stopReason: 'stop',
			usage,
		},
	];
}

describe('reduceConversationRecords()', () => {
	it('reconstructs canonical user and assistant messages when authoritative deltas complete', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');
		const conversation = state.conversations.get('conv_01');

		expect(conversation?.activeLeafId).toBe('entry_assistant');
		expect(buildConversationContext(required(conversation))).toMatchObject([
			{ role: 'user', content: [{ type: 'text', text: 'Hello' }] },
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'Hi there' }],
				stopReason: 'stop',
			},
		]);
	});

	it('produces equal state when records are applied individually or in batches', () => {
		const records = canonicalConversation();
		const batched = reduceConversationRecords(createReducedInstanceState(), records, '8');
		const individual = createReducedInstanceState();
		for (const record of records) applyConversationRecord(individual, record);
		individual.recordsThroughOffset = '8';

		expect(buildConversationContext(required(individual.conversations.get('conv_01')))).toEqual(
			buildConversationContext(required(batched.conversations.get('conv_01'))),
		);
		expect(getActiveConversationPath(required(individual.conversations.get('conv_01')))).toEqual(
			getActiveConversationPath(required(batched.conversations.get('conv_01'))),
		);
	});

	it('ignores an exact duplicate logical record when replay retries an append', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records, '8');

		applyConversationRecord(state, required(records[5]));

		expect(buildConversationContext(required(state.conversations.get('conv_01')))[1]).toMatchObject({
			content: [{ type: 'text', text: 'Hi there' }],
		});
	});

	it('rejects a conflicting duplicate logical record when replay content differs', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 6), '6');
		const conflicting = { ...required(records[5]), delta: 'different' } as ConversationRecord;

		expect(() => applyConversationRecord(state, conflicting)).toThrow(
			ConversationRecordInvariantError,
		);
	});

	it('rejects a noncontiguous delta when an acknowledged sequence is missing', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 4), '4');
		const secondDelta = required(records[5]);

		expect(() => applyConversationRecord(state, secondDelta)).toThrowError(
			expect.objectContaining({
				type: 'conversation_record_invariant',
				meta: expect.objectContaining({ reason: 'Expected delta sequence 0, received 1.' }),
			}),
		);
	});

	it('rejects completion when deltaCount does not match durable deltas', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 5), '5');
		const completion = required(records[6]);

		expect(() => applyConversationRecord(state, completion)).toThrowError(
			expect.objectContaining({
				type: 'conversation_record_invariant',
				meta: expect.objectContaining({
					reason: 'Completion expected 2 deltas but replay has 1.',
				}),
			}),
		);
	});

	it('does not mutate accepted state when a later record in one batch is invalid', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 4), '4');
		const accepted = required(records[4]);
		const invalid = required(records[6]);

		expect(() => reduceConversationRecords(state, [accepted, invalid], '6')).toThrow(
			ConversationRecordInvariantError,
		);
		expect(state.recordsById.has(accepted.id)).toBe(false);
		expect(
			state.conversations.get('conv_01')?.inProgressMessages.get('entry_assistant')?.blocks.get(
				'block_text',
			),
		).toMatchObject({ deltas: [] });
	});

	it('keeps partial assistant deltas as recovery state without advancing the active leaf', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 5), '5');
		const conversation = required(state.conversations.get('conv_01'));

		expect(conversation.activeLeafId).toBe('entry_user');
		expect(conversation.inProgressMessages.get('entry_assistant')).toMatchObject({
			messageId: 'entry_assistant',
		});
		expect(buildConversationContext(conversation)).toHaveLength(1);
	});

	it('projects one complete UI snapshot through the physical catch-up offset', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');
		const snapshot = projectConversationUi(required(state.conversations.get('conv_01')), '8');

		expect(snapshot).toMatchObject({
			conversationId: 'conv_01',
			streamOffset: '8',
			messages: [
				{ id: 'entry_user', role: 'user', parts: [{ type: 'text', text: 'Hello', state: 'done' }] },
				{
					id: 'entry_assistant',
					role: 'assistant',
					parts: [{ type: 'text', text: 'Hi there', state: 'done' }],
				},
			],
		});
	});

	it('projects durable partial deltas as one streaming UI message without model eligibility', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 5), '5');
		const conversation = required(state.conversations.get('conv_01'));

		expect(projectConversationUi(conversation, '5').messages[1]).toEqual({
			id: 'entry_assistant',
			role: 'assistant',
			parts: [{ type: 'text', blockId: 'block_text', text: 'Hi ', state: 'streaming' }],
		});
		expect(buildConversationContext(conversation)).toHaveLength(1);
		expect(classifyConversationSubmission(conversation, 'entry_user', { contextWindow: 100000 })).toMatchObject({
			kind: 'interrupted_partial',
			messageId: 'entry_assistant',
			assistant: { content: [{ type: 'text', text: 'Hi ' }], stopReason: 'aborted' },
		});
	});

	it('classifies submission progress from the canonical active path', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');

		expect(
			classifyConversationSubmission(required(state.conversations.get('conv_01')), 'entry_user', {
				contextWindow: 100000,
			}),
		).toMatchObject({ kind: 'completed', overflow: false });
	});

	it('rejects a tool result that does not match the next requested tool call', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 4), '4');
		applyConversationRecord(state, {
			...scope,
			id: 'record_tool_call',
			type: 'assistant_tool_call',
			timestamp: '2026-06-25T00:00:02.150Z',
			messageId: 'entry_assistant',
			blockId: 'block_tool',
			blockIndex: 1,
			toolCallId: 'call_expected',
			name: 'lookup',
			arguments: {},
		});
		applyConversationRecord(state, {
			...scope,
			id: 'record_empty_text_complete',
			type: 'assistant_text_completed',
			timestamp: '2026-06-25T00:00:02.200Z',
			messageId: 'entry_assistant',
			blockId: 'block_text',
			deltaCount: 0,
		});
		applyConversationRecord(state, {
			...scope,
			id: 'record_tool_assistant_complete',
			type: 'assistant_message_completed',
			timestamp: '2026-06-25T00:00:02.300Z',
			messageId: 'entry_assistant',
			stopReason: 'toolUse',
			usage,
		});

		expect(() =>
			applyConversationRecord(state, {
				...scope,
				id: 'record_wrong_tool_result',
				type: 'tool_result',
				timestamp: '2026-06-25T00:00:03.000Z',
				messageId: 'entry_result',
				parentId: 'entry_assistant',
				toolCallId: 'call_wrong',
				toolName: 'lookup',
				isError: false,
				content: [{ type: 'text', text: 'result' }],
			}),
		).toThrow(ConversationRecordInvariantError);
	});

	it('preserves attachment integrity metadata for UI and model resolution', () => {
		const created = required(canonicalConversation()[0]);
		const attachment = { id: 'att_01', mimeType: 'image/png', size: 42, digest: 'sha256:test' };
		const state = reduceConversationRecords(createReducedInstanceState(), [created, {
			...scope,
			id: 'record_attachment_user',
			type: 'user_message',
			timestamp: '2026-06-25T00:00:01.000Z',
			messageId: 'entry_attachment',
			parentId: null,
			content: [{ type: 'attachment', attachment }],
		}], '2');
		const conversation = required(state.conversations.get('conv_01'));

		expect(projectConversationUi(conversation, '2').messages[0]?.parts).toEqual([
			{ type: 'attachment', attachment },
		]);
		expect(
			buildConversationContext(conversation, {
				resolveAttachment(ref) {
					expect(ref).toEqual(attachment);
					return { data: 'base64', mimeType: ref.mimeType };
				},
			}),
		).toMatchObject([{ role: 'user', content: [{ type: 'image', data: 'base64', mimeType: 'image/png' }] }]);
	});

	it('rejects implicit branching when an entry parent is not the active leaf', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');

		expect(() =>
			applyConversationRecord(state, {
				...scope,
				id: 'record_implicit_branch',
				type: 'signal',
				timestamp: '2026-06-25T00:00:03.000Z',
				messageId: 'entry_implicit_branch',
				parentId: 'entry_user',
				signalType: 'submission_interrupted',
				content: 'This branch was not selected.',
			}),
		).toThrow(ConversationRecordInvariantError);
	});

	it('selects only the explicit active branch after a non-linear leaf change', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records, '8');
		applyConversationRecord(state, {
			...scope,
			id: 'record_rewind',
			type: 'active_leaf_changed',
			timestamp: '2026-06-25T00:00:03.000Z',
			leafId: 'entry_user',
			previousLeafId: 'entry_assistant',
			reason: 'repair',
		});
		applyConversationRecord(state, {
			...scope,
			id: 'record_signal',
			type: 'signal',
			timestamp: '2026-06-25T00:00:04.000Z',
			messageId: 'entry_signal',
			parentId: 'entry_user',
			signalType: 'submission_interrupted',
			content: 'Use the repaired branch.',
		});

		const conversation = required(state.conversations.get('conv_01'));
		expect(getActiveConversationPath(conversation).map((entry) => entry.id)).toEqual([
			'entry_user',
			'entry_signal',
		]);
		expect(buildConversationContext(conversation)).toHaveLength(2);
	});
});
