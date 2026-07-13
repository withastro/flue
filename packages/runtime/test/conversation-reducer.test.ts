import { describe, expect, it } from 'vitest';
import {
	aggregateConversationUsageSince,
	classifyConversationSubmission,
	getActiveConversationPathSince,
	getLatestConversationCompaction,
	projectConversationModelContextEntries,
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
			kind: 'root',
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

		expect(conversation).toMatchObject({
			activeLeafId: 'entry_assistant',
			createdAt: '2026-06-25T00:00:00.000Z',
		});
		expect(buildConversationContext(required(conversation))).toMatchObject([
			{ role: 'user', content: [{ type: 'text', text: 'Hello' }] },
			{
				role: 'assistant',
				content: [{ type: 'text', text: 'Hi there' }],
				stopReason: 'stop',
			},
		]);
	});

	it('round-trips text signatures and redacted-thinking markers into model context', () => {
		const records: ConversationRecord[] = [
			required(canonicalConversation()[0]),
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
				id: 'record_reasoning_start',
				type: 'assistant_reasoning_started',
				timestamp: '2026-06-25T00:00:02.100Z',
				messageId: 'entry_assistant',
				blockId: 'block_reasoning',
				blockIndex: 0,
			},
			{
				...scope,
				id: 'record_reasoning_delta',
				type: 'assistant_reasoning_delta',
				timestamp: '2026-06-25T00:00:02.150Z',
				messageId: 'entry_assistant',
				blockId: 'block_reasoning',
				sequence: 0,
				delta: 'redacted thinking',
			},
			{
				...scope,
				id: 'record_reasoning_complete',
				type: 'assistant_reasoning_completed',
				timestamp: '2026-06-25T00:00:02.200Z',
				messageId: 'entry_assistant',
				blockId: 'block_reasoning',
				deltaCount: 1,
				encrypted: 'enc_payload',
				redacted: true,
			},
			{
				...scope,
				id: 'record_text_start',
				type: 'assistant_text_started',
				timestamp: '2026-06-25T00:00:02.300Z',
				messageId: 'entry_assistant',
				blockId: 'block_text',
				blockIndex: 1,
			},
			{
				...scope,
				id: 'record_text_delta',
				type: 'assistant_text_delta',
				timestamp: '2026-06-25T00:00:02.350Z',
				messageId: 'entry_assistant',
				blockId: 'block_text',
				sequence: 0,
				delta: 'Answer',
			},
			{
				...scope,
				id: 'record_text_complete',
				type: 'assistant_text_completed',
				timestamp: '2026-06-25T00:00:02.400Z',
				messageId: 'entry_assistant',
				blockId: 'block_text',
				deltaCount: 1,
				textSignature: 'sig_text',
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
		const state = reduceConversationRecords(createReducedInstanceState(), records, '9');
		const conversation = required(state.conversations.get('conv_01'));

		expect(buildConversationContext(conversation)).toMatchObject([
			{ role: 'user' },
			{
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'redacted thinking', thinkingSignature: 'enc_payload', redacted: true },
					{ type: 'text', text: 'Answer', textSignature: 'sig_text' },
				],
			},
		]);
	});

	it('rejects a second conversation when one routing scope is already owned', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), [required(canonicalConversation()[0])]);

		expect(() => applyConversationRecord(state, {
			...scope,
			id: 'record_duplicate_scope',
			type: 'conversation_created',
			kind: 'root',
			conversationId: 'conv_02',
			timestamp: '2026-06-25T00:00:01.000Z',
			affinityKey: 'aff_02',
			createdAt: '2026-06-25T00:00:01.000Z',
		})).toThrow(ConversationRecordInvariantError);
	});

	it('rejects a child conversation when its parent does not exist', () => {
		expect(() => reduceConversationRecords(createReducedInstanceState(), [{
			...scope,
			id: 'record_orphan_child',
			type: 'conversation_created',
			kind: 'action',
			conversationId: 'conv_child',
			harness: 'default:action:123e4567-e89b-42d3-a456-426614174000',
			session: 'child',
			timestamp: '2026-06-25T00:00:01.000Z',
			affinityKey: 'aff_child',
			createdAt: '2026-06-25T00:00:01.000Z',
			parentConversationId: 'conv_missing',
			actionInvocationId: '123e4567-e89b-42d3-a456-426614174000',
		}])).toThrow(ConversationRecordInvariantError);
	});

	it('accepts valid atomic task and action topology', () => {
		const taskId = '123e4567-e89b-42d3-a456-426614174000';
		const invocationId = '123e4567-e89b-42d3-a456-426614174001';
		const state = reduceConversationRecords(createReducedInstanceState(), [
			required(canonicalConversation()[0]),
			{
				...scope,
				id: 'record_task_created',
				type: 'conversation_created',
				kind: 'task',
				conversationId: 'conv_task',
				session: `task:default:${taskId}`,
				timestamp: '2026-06-25T00:00:01.000Z',
				affinityKey: 'aff_task',
				createdAt: '2026-06-25T00:00:01.000Z',
				parentConversationId: 'conv_01',
				taskId,
			},
			{
				...scope,
				id: 'record_task_retained',
				type: 'child_session_retained',
				timestamp: '2026-06-25T00:00:01.000Z',
				child: {
					conversationId: 'conv_task',
					harness: 'default',
					session: `task:default:${taskId}`,
					type: 'task',
					taskId,
				},
			},
			{
				...scope,
				id: 'record_action_created',
				type: 'conversation_created',
				kind: 'action',
				conversationId: 'conv_action',
				harness: `default:action:${invocationId}`,
				session: 'action-child',
				timestamp: '2026-06-25T00:00:02.000Z',
				affinityKey: 'aff_action',
				createdAt: '2026-06-25T00:00:02.000Z',
				parentConversationId: 'conv_01',
				actionInvocationId: invocationId,
			},
			{
				...scope,
				id: 'record_action_retained',
				type: 'child_session_retained',
				timestamp: '2026-06-25T00:00:02.000Z',
				child: {
					conversationId: 'conv_action',
					harness: `default:action:${invocationId}`,
					session: 'action-child',
					type: 'action',
					invocationId,
				},
			},
		]);

		expect(state.conversations.get('conv_01')?.childConversations.size).toBe(2);
	});

	it('rejects contradictory conversation kind fields', () => {
		const contradictory = {
			...scope,
			id: 'record_contradictory_creation',
			type: 'conversation_created',
			kind: 'root',
			timestamp: '2026-06-25T00:00:00.000Z',
			affinityKey: 'aff_contradictory',
			createdAt: '2026-06-25T00:00:00.000Z',
			taskId: '123e4567-e89b-42d3-a456-426614174000',
		} as unknown as ConversationRecord;

		expect(() => applyConversationRecord(createReducedInstanceState(), contradictory)).toThrow(
			ConversationRecordInvariantError,
		);
	});

	it('rejects contradictory child kind fields', () => {
		const taskId = '123e4567-e89b-42d3-a456-426614174000';
		const state = reduceConversationRecords(createReducedInstanceState(), [
			required(canonicalConversation()[0]),
			{
				...scope,
				id: 'record_task_created',
				type: 'conversation_created',
				kind: 'task',
				conversationId: 'conv_task',
				session: `task:default:${taskId}`,
				timestamp: '2026-06-25T00:00:01.000Z',
				affinityKey: 'aff_task',
				createdAt: '2026-06-25T00:00:01.000Z',
				parentConversationId: 'conv_01',
				taskId,
			},
		]);
		const contradictory = {
			...scope,
			id: 'record_contradictory_child',
			type: 'child_session_retained',
			timestamp: '2026-06-25T00:00:02.000Z',
			child: {
				conversationId: 'conv_task',
				harness: 'default',
				session: `task:default:${taskId}`,
				type: 'task',
				taskId,
				invocationId: '123e4567-e89b-42d3-a456-426614174001',
			},
		} as unknown as ConversationRecord;

		expect(() => applyConversationRecord(state, contradictory)).toThrow(ConversationRecordInvariantError);
	});

	it('rejects malformed task identity derived from its parent', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), [required(canonicalConversation()[0])]);
		const malformed = {
			...scope,
			id: 'record_malformed_task',
			type: 'conversation_created',
			kind: 'task',
			conversationId: 'conv_task',
			session: 'task:default:not-a-uuid',
			timestamp: '2026-06-25T00:00:01.000Z',
			affinityKey: 'aff_task',
			createdAt: '2026-06-25T00:00:01.000Z',
			parentConversationId: 'conv_01',
			taskId: 'not-a-uuid',
		} as unknown as ConversationRecord;

		expect(() => applyConversationRecord(state, malformed)).toThrow(ConversationRecordInvariantError);
	});

	it('rejects malformed action scope derived from its parent', () => {
		const invocationId = '123e4567-e89b-42d3-a456-426614174001';
		const state = reduceConversationRecords(createReducedInstanceState(), [required(canonicalConversation()[0])]);

		expect(() => applyConversationRecord(state, {
			...scope,
			id: 'record_malformed_action',
			type: 'conversation_created',
			kind: 'action',
			conversationId: 'conv_action',
			harness: 'default:action:wrong',
			session: 'action-child',
			timestamp: '2026-06-25T00:00:01.000Z',
			affinityKey: 'aff_action',
			createdAt: '2026-06-25T00:00:01.000Z',
			parentConversationId: 'conv_01',
			actionInvocationId: invocationId,
		})).toThrow(ConversationRecordInvariantError);
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

	it('accepts the next user message when a settled submission left an orphaned assistant', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), [
			required(canonicalConversation()[0]),
			{
				...scope,
				id: 'record_user',
				type: 'user_message',
				timestamp: '2026-06-25T00:00:01.000Z',
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'Hello' }],
				submissionId: 'submission_01',
				attemptId: 'attempt_01',
			},
			{
				...scope,
				id: 'record_assistant_old_start',
				type: 'assistant_message_started',
				timestamp: '2026-06-25T00:00:02.000Z',
				messageId: 'entry_assistant_old',
				parentId: 'entry_user',
				turnId: 'turn_01',
				modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
				submissionId: 'submission_01',
				attemptId: 'attempt_01',
			},
			{
				...scope,
				id: 'record_assistant_replacement_start',
				type: 'assistant_message_started',
				timestamp: '2026-06-25T00:00:03.000Z',
				messageId: 'entry_assistant_replacement',
				parentId: 'entry_user',
				turnId: 'turn_02',
				modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
				submissionId: 'submission_01',
				attemptId: 'attempt_02',
			},
			{
				...scope,
				id: 'record_assistant_replacement_complete',
				type: 'assistant_message_completed',
				timestamp: '2026-06-25T00:00:04.000Z',
				messageId: 'entry_assistant_replacement',
				stopReason: 'error',
				usage,
				error: 'Provider failed.',
				submissionId: 'submission_01',
				attemptId: 'attempt_02',
			},
			{
				...scope,
				id: 'record_submission_settled',
				type: 'submission_settled',
				timestamp: '2026-06-25T00:00:05.000Z',
				submissionId: 'submission_01',
				attemptId: 'attempt_02',
				outcome: 'failed',
				error: { message: 'Provider failed.' },
			},
		], '5');

		expect(() => applyConversationRecord(state, {
			...scope,
			id: 'record_user_follow_up',
			type: 'user_message',
			timestamp: '2026-06-25T00:00:06.000Z',
			messageId: 'entry_user_follow_up',
			parentId: 'entry_assistant_replacement',
			content: [{ type: 'text', text: 'Try again' }],
			submissionId: 'submission_02',
			attemptId: 'attempt_03',
		})).not.toThrow();
	});

	it('preserves committed entries and the active leaf when settlement clears submission-owned assistants', () => {
		const records: ConversationRecord[] = [
			required(canonicalConversation()[0]),
			{
				...scope,
				id: 'record_user',
				type: 'user_message',
				timestamp: '2026-06-25T00:00:01.000Z',
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'Hello' }],
				submissionId: 'submission_01',
			},
			{
				...scope,
				id: 'record_assistant_old_start',
				type: 'assistant_message_started',
				timestamp: '2026-06-25T00:00:02.000Z',
				messageId: 'entry_assistant_old',
				parentId: 'entry_user',
				modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
				submissionId: 'submission_01',
			},
			{
				...scope,
				id: 'record_assistant_replacement_start',
				type: 'assistant_message_started',
				timestamp: '2026-06-25T00:00:03.000Z',
				messageId: 'entry_assistant_replacement',
				parentId: 'entry_user',
				modelInfo: { api: 'test', provider: 'test', model: 'test-model' },
				submissionId: 'submission_01',
			},
			{
				...scope,
				id: 'record_assistant_replacement_complete',
				type: 'assistant_message_completed',
				timestamp: '2026-06-25T00:00:04.000Z',
				messageId: 'entry_assistant_replacement',
				stopReason: 'error',
				usage,
				error: 'Provider failed.',
				submissionId: 'submission_01',
			},
		];
		const state = reduceConversationRecords(createReducedInstanceState(), records, '4');
		const conversation = required(state.conversations.get('conv_01'));
		const committedEntries = new Map(conversation.entries);
		const activeLeafId = conversation.activeLeafId;

		applyConversationRecord(state, {
			...scope,
			id: 'record_submission_settled',
			type: 'submission_settled',
			timestamp: '2026-06-25T00:00:05.000Z',
			submissionId: 'submission_01',
			outcome: 'failed',
			error: { message: 'Provider failed.' },
		});

		expect(conversation.inProgressMessages).toHaveLength(0);
		expect(conversation.entries).toEqual(committedEntries);
		expect(conversation.activeLeafId).toBe(activeLeafId);
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

	it('preserves submission identity across a completed projected turn when records carry the same submission', () => {
		const records = canonicalConversation().map((record) => {
			if (record.type === 'user_message' || record.type === 'assistant_message_started') {
				return { ...record, submissionId: 'submission_01' };
			}
			return record;
		});
		const state = reduceConversationRecords(createReducedInstanceState(), records, '8');
		const messages = projectConversationUi(required(state.conversations.get('conv_01')), '8').messages;

		expect(messages).toMatchObject([
			{ id: 'entry_user', role: 'user', submissionId: 'submission_01' },
			{ id: 'entry_assistant', role: 'assistant', submissionId: 'submission_01' },
		]);
	});

	it('stamps each projected message with its canonical creation timestamp', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');
		const messages = projectConversationUi(required(state.conversations.get('conv_01')), '8').messages;

		// User message: the time it was recorded. Assistant message: generation
		// start (the assistant_message_started record), carried alongside usage/model.
		expect(messages[0]?.metadata).toEqual({ timestamp: '2026-06-25T00:00:01.000Z' });
		expect(messages[1]?.metadata).toEqual({
			timestamp: '2026-06-25T00:00:02.000Z',
			usage,
			model: { provider: 'test', id: 'test-model' },
		});
	});

	it('projects an in-progress assistant shell even before its first delta so post-hydration deltas attach', () => {
		const state = reduceConversationRecords(
			createReducedInstanceState(),
			canonicalConversation().slice(0, 3),
			'2',
		);
		const conversation = required(state.conversations.get('conv_01'));

		// records[0..2] = created, user, assistant_message_started (no blocks yet).
		// The snapshot must still include the empty assistant message so a client
		// that hydrates here can attach the deltas that arrive after the offset.
		expect(projectConversationUi(conversation, '2').messages).toEqual([
			{
				id: 'entry_user',
				role: 'user',
				purpose: 'user',
				display: 'visible',
				parts: [{ type: 'text', text: 'Hello', state: 'done' }],
				metadata: { timestamp: '2026-06-25T00:00:01.000Z' },
			},
			{
				id: 'entry_assistant',
				role: 'assistant',
				purpose: 'assistant',
				display: 'visible',
				turnId: 'turn_01',
				parts: [],
				metadata: { timestamp: '2026-06-25T00:00:02.000Z' },
			},
		]);
	});

	it('projects durable partial deltas as one streaming UI message without model eligibility', () => {
		const records = canonicalConversation();
		const state = reduceConversationRecords(createReducedInstanceState(), records.slice(0, 5), '5');
		const conversation = required(state.conversations.get('conv_01'));

		expect(projectConversationUi(conversation, '5').messages[1]).toEqual({
			id: 'entry_assistant',
			role: 'assistant',
			purpose: 'assistant',
			display: 'visible',
			turnId: 'turn_01',
			parts: [{
				type: 'text',
				text: 'Hi ',
				state: 'streaming',
			}],
			metadata: { timestamp: '2026-06-25T00:00:02.000Z' },
		});
		expect(buildConversationContext(conversation)).toHaveLength(1);
		expect(classifyConversationSubmission(conversation, 'entry_user', { contextWindow: 100000 })).toMatchObject({
			kind: 'interrupted_partial',
			messageId: 'entry_assistant',
			assistant: { content: [{ type: 'text', text: 'Hi ' }], stopReason: 'aborted' },
		});
	});

	it('projects an internal signal as a typed system message instead of visible user chat', () => {
		const records: ConversationRecord[] = [
			{
				...scope,
				id: 'record_created',
				type: 'conversation_created',
				kind: 'root',
				timestamp: '2026-06-25T00:00:00.000Z',
				affinityKey: 'aff_01',
				createdAt: '2026-06-25T00:00:00.000Z',
			},
			{
				...scope,
				id: 'record_dispatch',
				type: 'signal',
				timestamp: '2026-06-25T00:00:01.000Z',
				messageId: 'entry_dispatch',
				parentId: null,
				submissionId: 'submission_01',
				turnId: 'turn_07',
				signalType: 'slack.message',
				tagName: 'dispatch',
				content: '{"input":"go"}',
				attributes: { agent: 'planner', dispatchId: 'dispatch_01' },
			},
		];
		const state = reduceConversationRecords(createReducedInstanceState(), records, '1');
		const conversation = required(state.conversations.get('conv_01'));

		expect(projectConversationUi(conversation, '1').messages).toEqual([
			{
				id: 'entry_dispatch',
				role: 'system',
				purpose: 'dispatch',
				display: 'diagnostic',
				submissionId: 'submission_01',
				turnId: 'turn_07',
				signal: { tagName: 'dispatch', attributes: { agent: 'planner', dispatchId: 'dispatch_01' } },
				parts: [{ type: 'text', text: '{"input":"go"}', state: 'done' }],
				metadata: { timestamp: '2026-06-25T00:00:01.000Z' },
			},
		]);
	});

	it('classifies a stream-recovery signal as a hidden advisory', () => {
		const records: ConversationRecord[] = [
			{
				...scope,
				id: 'record_created',
				type: 'conversation_created',
				kind: 'root',
				timestamp: '2026-06-25T00:00:00.000Z',
				affinityKey: 'aff_01',
				createdAt: '2026-06-25T00:00:00.000Z',
			},
			{
				...scope,
				id: 'record_recovery',
				type: 'signal',
				timestamp: '2026-06-25T00:00:01.000Z',
				messageId: 'entry_recovery',
				parentId: null,
				signalType: 'stream_interrupted',
				content: 'The previous response was interrupted.',
			},
		];
		const state = reduceConversationRecords(createReducedInstanceState(), records, '1');
		const conversation = required(state.conversations.get('conv_01'));

		expect(projectConversationUi(conversation, '1').messages[0]).toMatchObject({
			role: 'system',
			purpose: 'advisory',
			display: 'hidden',
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

	it('distinguishes a missing exact boundary from an empty path suffix', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');
		const conversation = required(state.conversations.get('conv_01'));

		expect(getActiveConversationPathSince(conversation, 'entry_assistant')).toEqual([]);
		expect(getActiveConversationPathSince(conversation, 'entry_missing')).toBeUndefined();
	});

	it('aggregates usage from the exact submission boundary', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');
		const conversation = required(state.conversations.get('conv_01'));

		expect(aggregateConversationUsageSince(conversation, 'entry_user')).toEqual(usage);
		expect(aggregateConversationUsageSince(conversation, 'entry_missing')).toBeUndefined();
	});

	it('retains source entry identity when projecting compacted model context', () => {
		const state = reduceConversationRecords(createReducedInstanceState(), canonicalConversation(), '8');
		applyConversationRecord(state, {
			...scope,
			id: 'record_compaction',
			type: 'compaction',
			timestamp: '2026-06-25T00:00:03.000Z',
			entryId: 'entry_compaction',
			parentId: 'entry_assistant',
			sourceLeafId: 'entry_assistant',
			firstKeptEntryId: 'entry_user',
			summary: 'Earlier context',
			tokensBefore: 12,
			usage,
		});
		const conversation = required(state.conversations.get('conv_01'));

		expect(getLatestConversationCompaction(conversation)?.id).toBe('entry_compaction');
		expect(
			projectConversationModelContextEntries(conversation).map((entry) => entry.sourceEntry.id),
		).toEqual(['entry_compaction', 'entry_user', 'entry_assistant']);
		expect(aggregateConversationUsageSince(conversation, 'entry_user')).toEqual({
			...usage,
			input: 20,
			output: 4,
			totalTokens: 24,
		});
	});

	it('materializes one complete ordered tool-results commit from durable outcomes', () => {
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
		applyConversationRecord(state, {
			...scope,
			id: 'record_tool_outcome',
			type: 'tool_outcome',
			timestamp: '2026-06-25T00:00:02.400Z',
			assistantMessageId: 'entry_assistant',
			toolCallId: 'call_expected',
			toolName: 'lookup',
			isError: false,
			content: [{ type: 'text', text: 'durable result' }],
		});
		const conversation = required(state.conversations.get('conv_01'));

		expect(conversation.activeLeafId).toBe('entry_assistant');
		expect(conversation.toolOutcomes.size).toBe(1);
		expect(buildConversationContext(conversation)).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }], timestamp: expect.any(Number) }]);

		const commit = {
			...scope,
			id: 'record_tool_commit',
			type: 'tool_results_committed' as const,
			timestamp: '2026-06-25T00:00:02.500Z',
			assistantMessageId: 'entry_assistant',
			parentId: 'entry_assistant',
			outcomeIds: ['record_tool_outcome'],
		};
		applyConversationRecord(state, commit);
		applyConversationRecord(state, commit);

		expect(conversation.activeLeafId).toMatch(/^entry_tool_result_/);
		expect(buildConversationContext(conversation)).toMatchObject([
			{ role: 'user' },
			{ role: 'assistant', stopReason: 'toolUse' },
			{ role: 'toolResult', toolCallId: 'call_expected', content: [{ type: 'text', text: 'durable result' }] },
		]);
	});

	it('projects durable tool-call duration onto the resolved dynamic-tool part', () => {
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
		applyConversationRecord(state, {
			...scope,
			id: 'record_tool_outcome',
			type: 'tool_outcome',
			timestamp: '2026-06-25T00:00:02.400Z',
			assistantMessageId: 'entry_assistant',
			toolCallId: 'call_expected',
			toolName: 'lookup',
			isError: false,
			content: [{ type: 'text', text: 'durable result' }],
			durationMs: 42,
		});
		applyConversationRecord(state, {
			...scope,
			id: 'record_tool_commit',
			type: 'tool_results_committed',
			timestamp: '2026-06-25T00:00:02.500Z',
			assistantMessageId: 'entry_assistant',
			parentId: 'entry_assistant',
			outcomeIds: ['record_tool_outcome'],
		});
		const conversation = required(state.conversations.get('conv_01'));

		const toolPart = projectConversationUi(conversation, '6')
			.messages.flatMap((message) => message.parts)
			.find((part) => part.type === 'dynamic-tool' && part.toolCallId === 'call_expected');
		expect(toolPart).toEqual({
			type: 'dynamic-tool',
			toolName: 'lookup',
			toolCallId: 'call_expected',
			state: 'output-available',
			input: {},
			output: 'durable result',
			durationMs: 42,
		});
	});

	it('rejects a tool-results commit that does not match the requested tool call', () => {
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
		applyConversationRecord(state, {
			...scope,
			id: 'record_wrong_outcome',
			type: 'tool_outcome',
			timestamp: '2026-06-25T00:00:02.400Z',
			assistantMessageId: 'entry_assistant',
			toolCallId: 'call_expected',
			toolName: 'lookup',
			isError: false,
			content: [{ type: 'text', text: 'result' }],
		});

		expect(() =>
			applyConversationRecord(state, {
				...scope,
				id: 'record_wrong_commit',
				type: 'tool_results_committed',
				timestamp: '2026-06-25T00:00:03.000Z',
				assistantMessageId: 'entry_assistant',
				parentId: 'entry_assistant',
				outcomeIds: [],
			}),
		).toThrow(ConversationRecordInvariantError);
	});

	it('keeps authored attachment text canonical and projects the manifest only for the model', () => {
		const created = required(canonicalConversation()[0]);
		const attachment = {
			id: 'att_01',
			mimeType: 'image/png',
			size: 42,
			digest: 'sha256:test',
			filename: 'diagram.png',
		};
		const state = reduceConversationRecords(createReducedInstanceState(), [created, {
			...scope,
			id: 'record_attachment_user',
			type: 'user_message',
			timestamp: '2026-06-25T00:00:01.000Z',
			messageId: 'entry_attachment',
			parentId: null,
			content: [
				{ type: 'text', text: 'Inspect this image.' },
				{ type: 'attachment', attachment },
			],
		}], '2');
		const conversation = required(state.conversations.get('conv_01'));

		expect(projectConversationUi(conversation, '2').messages[0]?.parts).toEqual([
			{ type: 'text', text: 'Inspect this image.', state: 'done' },
			{
				type: 'file',
				mediaType: attachment.mimeType,
				id: attachment.id,
				size: attachment.size,
				filename: attachment.filename,
			},
		]);
		expect(
			buildConversationContext(conversation, {
				resolveAttachment(ref) {
					expect(ref).toEqual(attachment);
					return { data: 'base64', mimeType: ref.mimeType };
				},
			}),
		).toMatchObject([{
			role: 'user',
			content: [
				{
					type: 'text',
					text: 'Inspect this image.\n\n<attachments>\n<image id="att_01" mimeType="image/png" />\n</attachments>',
				},
				{ type: 'image', data: 'base64', mimeType: 'image/png' },
			],
		}]);
	});

	it('projects a legacy authored attachment manifest only once', () => {
		const created = required(canonicalConversation()[0]);
		const attachment = { id: 'att_legacy', mimeType: 'image/png', size: 42, digest: 'sha256:test' };
		const text = 'Inspect this image.\n\n<attachments>\n<image id="att_legacy" mimeType="image/png" />\n</attachments>';
		const state = reduceConversationRecords(createReducedInstanceState(), [created, {
			...scope,
			id: 'record_legacy_attachment_user',
			type: 'user_message',
			timestamp: '2026-06-25T00:00:01.000Z',
			messageId: 'entry_legacy_attachment',
			parentId: null,
			content: [
				{ type: 'text', text },
				{ type: 'attachment', attachment },
			],
		}], '2');
		const conversation = required(state.conversations.get('conv_01'));

		expect(buildConversationContext(conversation, {
			resolveAttachment: () => ({ data: 'base64', mimeType: 'image/png' }),
		})).toMatchObject([{
			role: 'user',
			content: [
				{ type: 'text', text },
				{ type: 'image', data: 'base64', mimeType: 'image/png' },
			],
		}]);
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

});
