import { afterEach, describe, expect, it, vi } from 'vitest';
import { abandonedMessageRecordId } from './abandoned-message.ts';
import type { AgentSubmissionStore } from './agent-execution-store.ts';
import { createFlueContext } from './client.ts';
import { encodeReducedInstanceState } from './conversation-fold-checkpoint.ts';
import {
	projectAgentConversationBatch,
	projectAgentConversationSnapshot,
} from './conversation-public.ts';
import { loadReducedConversationState } from './conversation-reader.ts';
import type { ConversationRecord } from './conversation-records.ts';
import {
	REDUCED_STATE_FORMAT,
	reduceConversationRecords,
	toolResultEntryId,
} from './conversation-reducer.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { sqlite } from './node/agent-execution-store.ts';
import { processSubmission } from './runtime/agent-submissions.ts';
import { defineConversationStreamStoreContractTests } from './test-utils/define-conversation-stream-store-contract-tests.ts';

const path = 'agents/echo/case-a';
const identity = { agentName: 'echo', instanceId: 'case-a' };
const scope = { conversationId: 'conv_case_a', harness: 'default', session: 'default' };
const timestamp = '2026-09-11T00:00:00.000Z';
const envelope = { v: 1 as const, ...scope, timestamp };
const oldAttempt = { submissionId: 'old', attemptId: 'first-attempt' };
const secondAttempt = { submissionId: 'old', attemptId: 'second-attempt' };
const before = { submissionId: 'next', attemptId: 'next-attempt' };
const usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};
const adapters: ReturnType<typeof sqlite>[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	for (const adapter of adapters.splice(0)) await adapter.close?.();
});

async function stores() {
	const adapter = sqlite();
	adapters.push(adapter);
	await adapter.migrate?.();
	const connected = await adapter.connect();
	return { stream: connected.conversationStreamStore, submissions: connected.submissionStore };
}

async function claim(submissions: AgentSubmissionStore, attempt = before) {
	await submissions.admitDirect({
		kind: 'direct',
		submissionId: attempt.submissionId,
		agent: 'echo',
		id: 'case-a',
		message: { kind: 'user', body: 'next input' },
		acceptedAt: timestamp,
	});
	await submissions.markSubmissionCanonicalReady(attempt.submissionId);
	await submissions.claimSubmission({
		...attempt,
		ownerId: 'test',
		leaseExpiresAt: Date.now() + 30_000,
	});
}

async function fixture(settle = true) {
	const { stream, submissions } = await stores();
	const writer = await ConversationRecordWriter.create({
		store: stream,
		path,
		identity,
		producerId: 'first',
	});
	await writer.ensureConversation({
		...scope,
		kind: 'root',
		affinityKey: 'case-a',
		createdAt: timestamp,
	});
	await writer.append([
		{
			...envelope,
			id: 'history-open',
			type: 'assistant_message_started',
			messageId: 'entry_history',
			parentId: null,
			modelInfo: { api: 'openai-responses', provider: 'test', model: 'test' },
		},
		{
			...envelope,
			id: 'history-call',
			type: 'assistant_tool_call',
			messageId: 'entry_history',
			blockId: 'history-block',
			blockIndex: 0,
			toolCallId: 'history-call',
			name: 'saved-tool',
			arguments: {},
		},
		{
			...envelope,
			id: 'history-complete',
			type: 'assistant_message_completed',
			messageId: 'entry_history',
			stopReason: 'toolUse',
			usage,
		},
		{
			...envelope,
			id: 'history-outcome',
			type: 'tool_outcome',
			assistantMessageId: 'entry_history',
			toolCallId: 'history-call',
			toolName: 'saved-tool',
			isError: false,
			content: [{ type: 'text', text: 'saved result' }],
		},
		{
			...envelope,
			id: 'history-commit',
			type: 'tool_results_committed',
			assistantMessageId: 'entry_history',
			parentId: 'entry_history',
			outcomeIds: ['history-outcome'],
		},
	]);
	await submissions.admitDispatch({
		submissionId: 'old',
		agent: 'echo',
		id: 'case-a',
		message: { kind: 'user', body: 'old input' },
		acceptedAt: timestamp,
	});
	await submissions.markSubmissionCanonicalReady('old');
	await submissions.claimSubmission({
		...oldAttempt,
		ownerId: 'test',
		leaseExpiresAt: Date.now() + 30_000,
	});
	await writer.append(
		[
			{
				...envelope,
				...oldAttempt,
				id: 'input-old',
				type: 'user_message',
				messageId: 'entry_user_old',
				parentId: toolResultEntryId('entry_history', 'history-call'),
				content: [{ type: 'text', text: 'old input' }],
			},
			{
				...envelope,
				...oldAttempt,
				id: 'open-old',
				type: 'assistant_message_started',
				messageId: 'entry_abandoned',
				parentId: 'entry_user_old',
				modelInfo: { api: 'openai-responses', provider: 'test', model: 'test' },
			},
			{
				...envelope,
				...oldAttempt,
				id: 'old-tool',
				type: 'assistant_tool_call',
				messageId: 'entry_abandoned',
				blockId: 'tool-block',
				blockIndex: 0,
				toolCallId: 'old-call',
				name: 'old-tool',
				arguments: {},
			},
		],
		{ submission: oldAttempt },
	);
	await submissions.replaceSubmissionAttempt(oldAttempt, secondAttempt.attemptId);
	await writer.append(
		[
			{
				...envelope,
				...secondAttempt,
				id: 'open-sibling',
				type: 'assistant_message_started',
				messageId: 'entry_sibling',
				parentId: 'entry_user_old',
				modelInfo: { api: 'openai-responses', provider: 'test', model: 'test' },
			},
			{
				...envelope,
				...secondAttempt,
				id: 'complete-sibling',
				type: 'assistant_message_completed',
				messageId: 'entry_sibling',
				stopReason: 'stop',
				usage,
			},
		],
		{ submission: secondAttempt },
	);
	if (settle) await submissions.completeSubmission(secondAttempt);
	await claim(submissions);
	return { stream, submissions, writer };
}

function nextInput(): ConversationRecord {
	return {
		...envelope,
		...before,
		id: 'next-input',
		type: 'user_message',
		messageId: 'entry_next_user',
		parentId: 'entry_sibling',
		content: [{ type: 'text', text: 'next input' }],
	};
}

describe('abandoned message cleanup', () => {
	it.each([false, true])('awaits cleanup before input; append failure = %s', async (failAppend) => {
		const { stream, submissions, writer } = await fixture();
		const submission = await submissions.getSubmission(before.submissionId);
		if (!submission) throw new Error('Missing next submission');
		const ctx = createFlueContext({
			id: identity.instanceId,
			agentName: identity.agentName,
			submissionId: before.submissionId,
			env: {},
			agentConfig: { resolveModel: () => undefined },
			conversationWriter: writer,
		});
		const processInput = vi.fn(() =>
			writer.append([nextInput()], { submission: before }).then(() => undefined),
		);
		vi.spyOn(ctx, 'initializeRootHarness').mockResolvedValue({
			session: async () => ({ processSubmissionInput: processInput }),
		} as unknown as Awaited<ReturnType<typeof ctx.initializeRootHarness>>);
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const append = stream.append.bind(stream);
		vi.spyOn(stream, 'append').mockImplementation(async (input) => {
			if (input.abandonedMessage) {
				entered.resolve();
				await release.promise;
				if (failAppend) throw new Error('cleanup append failed');
			}
			return append(input);
		});
		const execution = processSubmission({
			submissions,
			submission,
			conversationWriter: writer,
			resolveAgent: () => () => '',
			createContext: () => ctx,
		});
		await entered.promise;
		expect(processInput).not.toHaveBeenCalled();
		release.resolve();
		if (failAppend) {
			await expect(execution).rejects.toThrow('cleanup append failed');
			expect(processInput).not.toHaveBeenCalled();
		} else {
			await execution;
			expect(processInput).toHaveBeenCalledOnce();
			expect(
				(await loadReducedConversationState({ store: stream, path })).conversations.get(
					scope.conversationId,
				)?.activeLeafId,
			).toBe('entry_next_user');
		}
	});

	it('clears the earlier attempt, preserves history, and permits later input after a fresh read', async () => {
		const { stream, submissions, writer } = await fixture();
		const oldRow = await submissions.getSubmission('old');
		const rawBefore = (await stream.read(path)).batches;
		const previous = await writer.loadReducedState();
		await expect(writer.append([nextInput()], { submission: before })).rejects.toThrow(/stream/i);
		await writer.clearAbandonedMessages(submissions, before);
		const state = await loadReducedConversationState({ store: stream, path });
		const conversation = state.conversations.get(scope.conversationId);
		expect(conversation?.inProgressMessages.size).toBe(0);
		expect(conversation?.activeLeafId).toBe('entry_sibling');
		expect(conversation?.entries).toEqual(
			previous.conversations.get(scope.conversationId)?.entries,
		);
		expect(conversation?.toolOutcomes).toEqual(
			previous.conversations.get(scope.conversationId)?.toolOutcomes,
		);
		expect(
			conversation?.entries.get(toolResultEntryId('entry_history', 'history-call')),
		).toMatchObject({
			message: { role: 'toolResult', content: [{ type: 'text', text: 'saved result' }] },
		});
		expect(await submissions.getSubmission('old')).toEqual(oldRow);
		const batches = (await stream.read(path)).batches;
		expect(batches.slice(0, -1)).toEqual(rawBefore);
		const record = batches.at(-1)?.records[0];
		expect(record).toMatchObject({
			v: 2,
			type: 'assistant_message_abandoned',
			submissionId: 'old',
			messageId: 'entry_abandoned',
		});
		expect(record).not.toHaveProperty('attemptId');
		expect(record).not.toHaveProperty('outcome');
		expect(record?.id).toBe(
			abandonedMessageRecordId(scope.conversationId, 'old', 'entry_abandoned'),
		);
		expect(
			projectAgentConversationBatch({
				state,
				previousState: previous,
				records: [record as ConversationRecord],
				batchOrdinal: batches.length - 1,
			}),
		).toEqual([
			{
				type: 'conversation-reset',
				conversationId: scope.conversationId,
				snapshot: projectAgentConversationSnapshot(state),
				position: { batch: batches.length - 1, index: 0 },
			},
		]);
		await writer.clearAbandonedMessages(submissions, before);
		expect((await stream.read(path)).batches).toEqual(batches);
		const freshWriter = await ConversationRecordWriter.create({
			store: stream,
			path,
			identity,
			producerId: 'fresh',
		});
		await freshWriter.clearAbandonedMessages(submissions, before);
		await freshWriter.append([nextInput()], { submission: before });
		const fresh = await loadReducedConversationState({ store: stream, path });
		expect(fresh.conversations.get(scope.conversationId)?.activeLeafId).toBe('entry_next_user');
	});

	it('drains pending completion before selecting the old message', async () => {
		const { stream, submissions, writer } = await fixture();
		await writer.clearAbandonedMessages(submissions, before);
		const pending = writer.enqueue(
			[
				{
					...envelope,
					...before,
					id: 'next-open',
					type: 'assistant_message_started',
					messageId: 'entry_next_answer',
					parentId: 'entry_sibling',
					modelInfo: { api: 'openai-responses', provider: 'test', model: 'test' },
				},
				{
					...envelope,
					...before,
					id: 'next-complete',
					type: 'assistant_message_completed',
					messageId: 'entry_next_answer',
					stopReason: 'stop',
					usage,
				},
			],
			{ submission: before },
		);
		await writer.clearAbandonedMessages(submissions, before);
		await pending;
		expect(
			(await loadReducedConversationState({ store: stream, path })).conversations.get(
				scope.conversationId,
			)?.activeLeafId,
		).toBe('entry_next_answer');
	});

	it('keeps refusal when the target is still running', async () => {
		const { stream, submissions, writer } = await fixture(false);
		const initial = (await stream.read(path)).batches;
		await expect(writer.clearAbandonedMessages(submissions, before)).rejects.toThrow();
		expect((await stream.read(path)).batches).toEqual(initial);
		await expect(writer.append([nextInput()], { submission: before })).rejects.toThrow(/stream/i);
	});

	it('keeps an open message at the active tail', async () => {
		const { stream, submissions, writer } = await fixture();
		await writer.append(
			[
				{
					...envelope,
					...before,
					id: 'tail-open',
					type: 'assistant_message_started',
					messageId: 'entry_tail',
					parentId: 'entry_sibling',
					modelInfo: { api: 'openai-responses', provider: 'test', model: 'test' },
				},
			],
			{ submission: before },
		);
		await writer.clearAbandonedMessages(submissions, before);
		const conversation = (
			await loadReducedConversationState({ store: stream, path })
		).conversations.get(scope.conversationId);
		expect([...(conversation?.inProgressMessages.keys() ?? [])]).toEqual(['entry_tail']);
		expect(conversation?.activeLeafId).toBe('entry_sibling');
		await expect(writer.append([nextInput()], { submission: before })).rejects.toThrow();
	});

	it('propagates row-read and append failures without clearing the message', async () => {
		const { stream, submissions, writer } = await fixture();
		const read = vi
			.spyOn(submissions, 'getSubmission')
			.mockRejectedValueOnce(new Error('row read failed'));
		await expect(writer.clearAbandonedMessages(submissions, before)).rejects.toThrow(
			'row read failed',
		);
		read.mockRestore();
		vi.spyOn(stream, 'append').mockRejectedValue(new Error('append failed'));
		await expect(writer.clearAbandonedMessages(submissions, before)).rejects.toThrow(
			'append failed',
		);
		const state = await loadReducedConversationState({ store: stream, path });
		expect(
			state.conversations.get(scope.conversationId)?.inProgressMessages.has('entry_abandoned'),
		).toBe(true);
		expect(state.conversations.get(scope.conversationId)?.activeLeafId).toBe('entry_sibling');
	});

	it('rejects a successor replaced between the writer read and the storage transaction', async () => {
		const { stream, submissions, writer } = await fixture();
		const original = submissions.getSubmission.bind(submissions);
		vi.spyOn(submissions, 'getSubmission').mockImplementation(async (id) => {
			const row = await original(id);
			if (id === 'old') await submissions.replaceSubmissionAttempt(before, 'replacement');
			return row;
		});
		await expect(writer.clearAbandonedMessages(submissions, before)).rejects.toMatchObject({
			meta: { reason: 'Abandoned message successor attempt is no longer running.' },
		});
		expect(
			(await loadReducedConversationState({ store: stream, path })).conversations
				.get(scope.conversationId)
				?.inProgressMessages.has('entry_abandoned'),
		).toBe(true);
	});

	it('rebuilds an old checkpoint and restores a new checkpoint with cleanup applied', async () => {
		const { stream, submissions, writer } = await fixture();
		const oldState = await writer.loadReducedState();
		const meta = await stream.getMeta(path);
		if (!meta) throw new Error('Missing test stream');
		await stream.putFoldCheckpoint?.(path, {
			offset: oldState.recordsThroughOffset,
			incarnation: meta.incarnation,
			formatVersion: REDUCED_STATE_FORMAT - 1,
			data: encodeReducedInstanceState(oldState),
		});
		await writer.clearAbandonedMessages(submissions, before);
		const fresh = await loadReducedConversationState({ store: stream, path });
		expect(fresh.conversations.get(scope.conversationId)?.inProgressMessages.size).toBe(0);
		await stream.putFoldCheckpoint?.(path, {
			offset: fresh.recordsThroughOffset,
			incarnation: meta.incarnation,
			formatVersion: REDUCED_STATE_FORMAT,
			data: encodeReducedInstanceState(fresh),
		});
		expect(await loadReducedConversationState({ store: stream, path })).toEqual(fresh);
		const record = (await stream.read(path)).batches.at(-1)?.records[0];
		if (!record) throw new Error('Missing cleanup record');
		expect(reduceConversationRecords(fresh, [record], fresh.recordsThroughOffset)).toEqual(fresh);
	});
});

defineConversationStreamStoreContractTests('SQLite conversation store', {
	async create() {
		const { stream, submissions } = await stores();
		return { stream, submissionStore: submissions };
	},
});
