import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai';
import { expect, it } from 'vitest';
import { type ConversationRecord, encodeCanonicalId } from './conversation-records.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { InMemoryAttachmentStore } from './runtime/attachment-store.ts';
import { InMemoryConversationStreamStore } from './runtime/conversation-stream-store.ts';
import { generateTaskId } from './runtime/ids.ts';
import { Session } from './session.ts';
import { createTaskSessionName } from './session-identity.ts';

const submissionId = 'submission_test';
const requestId = 'entry_request';
const scope = { conversationId: 'conversation_test', harness: 'default', session: 'default' };
const envelope = {
	...scope,
	v: 1 as const,
	timestamp: '2026-09-11T00:00:00.000Z',
	submissionId,
	attemptId: 'attempt_test',
};
const appendOptions = { submission: { submissionId, attemptId: envelope.attemptId } };
const terminal = {
	submissionId,
	kind: 'dispatch' as const,
	reason: 'aborted' as const,
	message: 'Stopped.',
};
const unknownContent = [
	{
		type: 'text' as const,
		text: JSON.stringify({
			type: 'interrupted',
			message: 'Tool execution was interrupted before completion. The outcome is unknown.',
		}),
	},
];

class TestStream extends InMemoryConversationStreamStore {
	readonly records: ConversationRecord[] = [];
	refuseCommit = false;
	readonly failure = new Error('Test storage refuses the repair commit.');
	override async append(input: Parameters<InMemoryConversationStreamStore['append']>[0]) {
		if (
			this.refuseCommit &&
			input.records.some((record) => record.type === 'tool_results_committed')
		)
			throw this.failure;
		const result = await super.append(input);
		this.records.push(...structuredClone(input.records));
		return result;
	}
}

async function newWriter(store: TestStream, producerId: string) {
	return ConversationRecordWriter.create({
		store,
		path: 'test-stream',
		identity: { agentName: 'Test', instanceId: 'terminal' },
		producerId,
	});
}

async function newSession(writer: ConversationRecordWriter) {
	const conversation = await writer.getConversation(scope.conversationId);
	if (!conversation) throw new Error('The test conversation is missing.');
	const model = fauxProvider({ models: [{ id: 'm' }] }).getModel();
	return new Session({
		name: scope.session,
		conversation,
		conversationWriter: writer,
		attachmentStore: new InMemoryAttachmentStore(),
		config: {
			systemPrompt: 'Test terminal records.',
			skills: {},
			model,
			resolveModel: () => model,
		},
		envSlot: { env: undefined, toolFactory: undefined, rediscoverNeeded: false },
	});
}

async function seedBatch(store: TestStream) {
	const writer = await newWriter(store, 'initial');
	await writer.ensureConversation({
		...scope,
		kind: 'root',
		affinityKey: 'test',
		createdAt: envelope.timestamp,
	});
	const response = fauxAssistantMessage([], { stopReason: 'toolUse' });
	await writer.append(
		[
			{
				...envelope,
				id: 'record_start',
				type: 'assistant_message_started',
				messageId: requestId,
				parentId: null,
				modelInfo: { api: response.api, provider: response.provider, model: response.model },
			},
			{
				...envelope,
				id: 'record_call_first',
				type: 'assistant_tool_call',
				messageId: requestId,
				blockId: 'block_first',
				blockIndex: 0,
				toolCallId: 'call_first',
				name: 'first',
				arguments: {},
			},
			{
				...envelope,
				id: 'record_call_task',
				type: 'assistant_tool_call',
				messageId: requestId,
				blockId: 'block_task',
				blockIndex: 1,
				toolCallId: 'call_task',
				name: 'task',
				arguments: {},
			},
			{
				...envelope,
				id: 'record_complete',
				type: 'assistant_message_completed',
				messageId: requestId,
				stopReason: 'toolUse',
				usage: response.usage,
			},
			{
				...envelope,
				id: 'record_first_outcome',
				type: 'tool_outcome',
				assistantMessageId: requestId,
				toolCallId: 'call_first',
				toolName: 'first',
				isError: true,
				content: unknownContent,
			},
			{
				...envelope,
				id: 'record_stored_state',
				type: 'state_write',
				name: 'phase',
				value: 'stored',
			},
		],
		appendOptions,
	);
	const taskId = generateTaskId();
	const child = {
		type: 'task' as const,
		conversationId: 'conversation_child',
		harness: scope.harness,
		session: createTaskSessionName(scope.session, taskId),
		taskId,
		parentToolCallId: 'call_task',
		parentAssistantEntryId: requestId,
	};
	await writer.ensureChildConversation({
		parent: scope,
		child: {
			...child,
			kind: 'task',
			affinityKey: 'child',
			createdAt: envelope.timestamp,
			parentConversationId: scope.conversationId,
		},
		ref: child,
	});
	return { writer, child };
}

it('keeps child references and interrupted IDs across fresh terminal sessions', async () => {
	const store = new TestStream();
	const { writer, child } = await seedBatch(store);
	const firstOutcome = structuredClone(
		store.records.find((record) => record.id === 'record_first_outcome'),
	);
	const session = await newSession(writer);
	try {
		await expect(session.recordSubmissionTerminal(terminal)).resolves.toEqual([
			{ name: 'task', id: 'call_task' },
		]);
	} finally {
		await session.close();
	}
	const before = structuredClone(store.records);
	const restarted = await newSession(await newWriter(store, 'restarted'));
	try {
		await expect(restarted.recordSubmissionTerminal(terminal)).resolves.toEqual([
			{ name: 'task', id: 'call_task' },
		]);
		await expect(restarted.recordSubmissionTerminal(terminal)).resolves.toEqual([
			{ name: 'task', id: 'call_task' },
		]);
	} finally {
		await restarted.close();
	}
	expect(store.records).toEqual(before);
	expect(store.records.filter((record) => record.id === 'record_first_outcome')).toEqual([
		firstOutcome,
	]);
	expect(store.records.filter((record) => record.type === 'child_session_retained')).toMatchObject([
		{ child },
	]);
	const outcomes = store.records.filter((record) => record.type === 'tool_outcome');
	expect(outcomes).toHaveLength(2);
	expect(outcomes[1]).toMatchObject({
		content: [
			{
				type: 'text',
				text: JSON.stringify({
					type: 'interrupted',
					message: 'Tool execution was interrupted before completion. The outcome is unknown.',
					childConversationId: child.conversationId,
				}),
			},
		],
	});
	expect(store.records.filter((record) => record.type === 'tool_results_committed')).toMatchObject([
		{ outcomeIds: outcomes.map((outcome) => outcome.id) },
	]);
	expect(store.records.filter((record) => record.type === 'signal')).toHaveLength(1);
	expect(store.records.filter((record) => record.type === 'state_write')).toMatchObject([
		{ name: 'phase', value: 'stored' },
	]);
});

it('propagates a commit failure and completes the same repair after restart', async () => {
	const store = new TestStream();
	const { writer } = await seedBatch(store);
	store.refuseCommit = true;
	const interrupted = await newSession(writer);
	try {
		await expect(interrupted.recordSubmissionTerminal(terminal)).rejects.toBe(store.failure);
	} finally {
		await interrupted.close();
	}
	const appendedOutcomes = structuredClone(
		store.records.filter((record) => record.type === 'tool_outcome'),
	);
	expect(appendedOutcomes).toHaveLength(2);
	expect(
		store.records.filter(
			(record) => record.type === 'tool_results_committed' || record.type === 'signal',
		),
	).toEqual([]);
	store.refuseCommit = false;
	const restarted = await newSession(await newWriter(store, 'retry'));
	try {
		await expect(restarted.recordSubmissionTerminal(terminal)).resolves.toEqual([
			{ name: 'task', id: 'call_task' },
		]);
		await expect(restarted.recordSubmissionTerminal(terminal)).resolves.toEqual([
			{ name: 'task', id: 'call_task' },
		]);
	} finally {
		await restarted.close();
	}
	expect(store.records.filter((record) => record.type === 'tool_outcome')).toEqual(
		appendedOutcomes,
	);
	expect(store.records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(
		1,
	);
	expect(store.records.filter((record) => record.type === 'signal')).toHaveLength(1);
});

it('refuses terminal cleanup of another submission without repairing its batch', async () => {
	const store = new TestStream();
	const { writer } = await seedBatch(store);
	const before = structuredClone(store.records);
	const session = await newSession(writer);
	try {
		await expect(
			session.recordSubmissionTerminal({ ...terminal, submissionId: 'another_submission' }),
		).rejects.toMatchObject({ name: 'ConversationRecordInvariantError' });
	} finally {
		await session.close();
	}
	expect(store.records).toEqual(before);
});

it.each(['missing', 'duplicate', 'reversed'] as const)(
	'refuses a non-aborted %s result list',
	async (kind) => {
		const store = new TestStream();
		const { writer } = await seedBatch(store);
		await writer.append(
			[
				{
					...envelope,
					id: 'record_task_outcome',
					type: 'tool_outcome',
					assistantMessageId: requestId,
					toolCallId: 'call_task',
					toolName: 'task',
					isError: false,
					content: [{ type: 'text', text: 'Stored task result.' }],
				},
			],
			appendOptions,
		);
		const before = structuredClone(store.records);
		const outcomeIds =
			kind === 'missing'
				? ['record_first_outcome']
				: kind === 'duplicate'
					? ['record_first_outcome', 'record_first_outcome']
					: ['record_task_outcome', 'record_first_outcome'];
		await expect(
			writer.append(
				[
					{
						...envelope,
						id: `record_tool_results_committed_${encodeCanonicalId(requestId)}`,
						type: 'tool_results_committed',
						assistantMessageId: requestId,
						parentId: requestId,
						outcomeIds,
					},
				],
				appendOptions,
			),
		).rejects.toMatchObject({ name: 'ConversationRecordInvariantError' });
		expect(store.records).toEqual(before);
	},
);
