import {
	type FauxModelDefinition,
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxThinking,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationRecordWriter } from '../src/conversation-writer.ts';
import {
	defineAgent,
	defineTool,
	ModelNotConfiguredError,
	observe,
	SessionBusyError,
} from '../src/index.ts';
import { createFlueContext, InMemoryAttachmentStore, InMemoryConversationStreamStore } from '../src/internal.ts';
import { createAttachmentRef } from '../src/runtime/attachment-store.ts';
import { getInternalSession } from '../src/session.ts';
import type { SessionEnv } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(models?: FauxModelDefinition[]): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `session-operations-test-${crypto.randomUUID()}`,
		models,
	});
	providers.push(provider);
	return provider;
}

function createContext(
	provider: FauxProviderRegistration,
	options: { env?: SessionEnv } = {},
) {
	return createFlueContext({
		id: 'session-operations-instance',
		env: {},
		agentConfig: {
			resolveModel: (specifier) => {
				if (!specifier) return undefined;
				return provider.getModel(specifier.slice(specifier.indexOf('/') + 1));
			},
		},
		createDefaultEnv: async () => options.env ?? createNoopSessionEnv(),
	});
}

describe('session.prompt()', () => {




	it('emits streaming deltas and final messages without public message updates when a prompt streams text and thinking', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([
			fauxAssistantMessage([
				fauxThinking('Inspect inputs'),
				{ type: 'text', text: 'Reviewed workspace.' },
			]),
		]);
		const ctx = createContext(provider);
		const events: Array<{ type: string; eventIndex: number; [key: string]: unknown }> = [];
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');

		expect(events.some((event) => event.type === 'message_update')).toBe(false);
		const thinkingEvents = events.filter((event) => event.type.startsWith('thinking_'));
		expect(thinkingEvents).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'thinking_start', contentIndex: 0 }),
				expect.objectContaining({ type: 'thinking_delta', contentIndex: 0 }),
				expect.objectContaining({ type: 'thinking_end', contentIndex: 0, content: 'Inspect inputs' }),
			]),
		);
		expect(
			thinkingEvents
				.filter((event) => event.type === 'thinking_delta')
				.map((event) => event.delta)
				.join(''),
		).toBe('Inspect inputs');
		expect(
			events
				.filter((event) => event.type === 'text_delta')
				.map((event) => event.text)
				.join(''),
		).toBe('Reviewed workspace.');
		const assistantMessageEnd = events.find(
			(event) =>
				event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant',
		);
		expect(assistantMessageEnd).toMatchObject({
			type: 'message_end',
			message: {
				role: 'assistant',
				content: [
					{ type: 'thinking', thinking: 'Inspect inputs' },
					{ type: 'text', text: 'Reviewed workspace.' },
				],
			},
			turnId: expect.any(String),
		});
		expect(events.map((event) => event.eventIndex)).toEqual(events.map((_, index) => index));
		expect(events.indexOf(assistantMessageEnd as (typeof events)[number])).toBeGreaterThan(
			events.findLastIndex((event) => event.type === 'text_delta'),
		);
	});


	it('returns assistant text usage and model identity when a prompt completes', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([fauxAssistantMessage('Reviewed workspace.')]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const response = await session.prompt('Review this workspace.');

		expect(response).toEqual({
			text: 'Reviewed workspace.',
			usage: {
				input: expect.any(Number),
				output: 5,
				cacheRead: 0,
				cacheWrite: expect.any(Number),
				totalTokens: expect.any(Number),
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			model: { provider: provider.getModel().provider, id: 'reviewer' },
		});
		expect(response.usage.input).toBeGreaterThan(0);
		expect(response.usage.cacheWrite).toBeGreaterThan(0);
		expect(response.usage.totalTokens).toBe(
			response.usage.input +
				response.usage.output +
				response.usage.cacheRead +
				response.usage.cacheWrite,
		);
	});

	it('returns the recovered response when a model turn fails transiently', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProvider([{ id: 'reviewer' }]);
			const requests: unknown[][] = [];
			provider.setResponses([
				fauxAssistantMessage('partial response', {
					stopReason: 'error',
					errorMessage: 'overloaded_error',
				}),
				(context) => {
					requests.push(context.messages);
					return fauxAssistantMessage('Recovered response.');
				},
			]);
			const events: unknown[] = [];
			const ctx = createContext(provider);
			ctx.subscribeEvent((event) => {
				events.push(event);
			});
			const harness = await ctx.initializeRootHarness(
				defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
			);
			const session = await harness.session();

			const response = session.prompt('Review this workspace.');
			await vi.advanceTimersByTimeAsync(2_000);

			await expect(response).resolves.toMatchObject({ text: 'Recovered response.' });
			expect(provider.state.callCount).toBe(2);
			expect(requests[0]).toEqual([expect.objectContaining({ role: 'user' })]);
			expect(
				events.filter(
					(event) =>
						typeof event === 'object' &&
						event !== null &&
						'type' in event &&
						event.type === 'log' &&
						'message' in event &&
						event.message === '[flue:model-retry] Retrying transient model error',
				),
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects when transient model failures exhaust the retry budget', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProvider([{ id: 'reviewer' }]);
			provider.setResponses(
				Array.from({ length: 4 }, () =>
					fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded_error' }),
				),
			);
			const ctx = createContext(provider);
			const harness = await ctx.initializeRootHarness(
				defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
			);
			const session = await harness.session();

			const response = session.prompt('Review this workspace.');
			const rejected = expect(response).rejects.toThrow('overloaded_error');
			await vi.runAllTimersAsync();

			await rejected;
			expect(provider.state.callCount).toBe(4);
		} finally {
			vi.useRealTimers();
		}
	});

	it('retries every transient model error when successful turns separate the failures', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProvider([{ id: 'reviewer' }]);
			const transientError = () =>
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded_error' });
			const lookupTurn = () =>
				fauxAssistantMessage(fauxToolCall('lookup', { query: 'flue' }), { stopReason: 'toolUse' });
			// Four isolated transient errors, each recovered and followed by a
			// successful tool-use turn: only consecutive failures share a budget.
			provider.setResponses([
				transientError(),
				lookupTurn(),
				transientError(),
				lookupTurn(),
				transientError(),
				lookupTurn(),
				transientError(),
				fauxAssistantMessage('Completed despite sporadic failures.'),
			]);
			const lookup = defineTool({
				name: 'lookup',
				description: 'Look up a value.',
				input: v.object({ query: v.string() }),
				run: async () => 'Found the requested value.',
			});
			const ctx = createContext(provider);
			const harness = await ctx.initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/reviewer`,
					tools: [lookup],
				})),
			);
			const session = await harness.session();

			const response = session.prompt('Review this workspace.');
			await vi.runAllTimersAsync();

			await expect(response).resolves.toMatchObject({
				text: 'Completed despite sporadic failures.',
			});
			expect(provider.state.callCount).toBe(8);
		} finally {
			vi.useRealTimers();
		}
	});

	it('does not retry a permanent model error', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid_api_key' }),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await expect(session.prompt('Review this workspace.')).rejects.toThrow('invalid_api_key');

		expect(provider.state.callCount).toBe(1);
	});

	it('excludes a terminal failed turn from the next prompt on the same session', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let retryContext: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'invalid_api_key' }),
			(context) => {
				retryContext = context.messages;
				return fauxAssistantMessage('Recovered after configuration update.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();
		await expect(session.prompt('First attempt.')).rejects.toThrow('invalid_api_key');

		await expect(session.prompt('Try after configuration update.')).resolves.toMatchObject({
			text: 'Recovered after configuration update.',
		});

		expect(retryContext).toEqual([
			expect.objectContaining({ role: 'user' }),
			expect.objectContaining({ role: 'user' }),
		]);
	});


	it('uses a call-level model when a prompt overrides the agent model', async () => {
		const provider = createProvider([{ id: 'default-model' }, { id: 'override-model' }]);
		const selectedModels: string[] = [];
		provider.setResponses([
			(_context, _options, _state, model) => {
				selectedModels.push(model.id);
				return fauxAssistantMessage('Used override.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/default-model` })),
		);
		const session = await harness.session();

		const response = await session.prompt('Use the requested model.', {
			model: `${provider.getModel().provider}/override-model`,
		});

		expect(selectedModels).toEqual(['override-model']);
		expect(response.model).toEqual({
			provider: provider.getModel().provider,
			id: 'override-model',
		});
	});

	it('rejects a model operation when neither the agent nor the call configures a model', async () => {
		const provider = createProvider();
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(defineAgent(() => ({ model: false })));
		const session = await harness.session();

		await expect(session.prompt('Review this workspace.')).rejects.toThrow(ModelNotConfiguredError);
	});

	it('applies a call-level thinking level when a prompt overrides the agent default', async () => {
		const provider = createProvider([{ id: 'reasoner', reasoning: true }]);
		const reasoningLevels: Array<string | undefined> = [];
		provider.setResponses([
			(_context, options) => {
				reasoningLevels.push((options as { reasoning?: string } | undefined)?.reasoning);
				return fauxAssistantMessage('Reasoned response.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reasoner`,
				thinkingLevel: 'low',
			})),
		);
		const session = await harness.session();

		await session.prompt('Think carefully.', { thinkingLevel: 'high' });

		expect(reasoningLevels).toEqual(['high']);
	});

	it('rejects overlapping operations when a session is already running an operation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let markStarted: () => void = () => {};
		let finishResponse: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const responseGate = new Promise<void>((resolve) => {
			finishResponse = resolve;
		});
		provider.setResponses([
			async () => {
				markStarted();
				await responseGate;
				return fauxAssistantMessage('First response complete.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const first = session.prompt('Start the first review.');
		await started;
		let firstResponse: Awaited<typeof first>;

		try {
			await expect(session.prompt('Start a second review.')).rejects.toThrow(SessionBusyError);
		} finally {
			finishResponse();
			firstResponse = await first;
		}
		expect(firstResponse).toMatchObject({ text: 'First response complete.' });
	});
});

describe('session.task()', () => {
	it('isolates delegated conversation state from the parent session when task() is called', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const taskRequests: string[][] = [];
		provider.setResponses([
			fauxAssistantMessage('Parent response.'),
			(context) => {
				taskRequests.push(
					context.messages.map((message) =>
						typeof message.content === 'string'
							? message.content
							: message.content
									.map((block) => ('text' in block ? block.text : block.type))
									.join('\n'),
					),
				);
				return fauxAssistantMessage('Delegated response.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();
		await session.prompt('Remember parent-only context.');

		const response = await session.task('Review only the delegated input.');

		expect(response.text).toBe('Delegated response.');
		expect(taskRequests).toEqual([['Review only the delegated input.']]);
	});

	it('keeps distinct dispatch IDs distinct when sanitized forms would collide', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([
			fauxAssistantMessage('First response.'),
			fauxAssistantMessage('Second response.'),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();
		const internal = getInternalSession(session);
		if (!internal) throw new Error('Expected internal session.');

		const first = await internal.processSubmissionInput({
			kind: 'dispatch',
			submissionId: 'job/a',
			dispatchId: 'job/a',
			agent: 'assistant',
			id: 'agent-1',
			input: { value: 'first' },
			acceptedAt: new Date().toISOString(),
		});
		const second = await internal.processSubmissionInput({
			kind: 'dispatch',
			submissionId: 'job?a',
			dispatchId: 'job?a',
			agent: 'assistant',
			id: 'agent-1',
			input: { value: 'second' },
			acceptedAt: new Date().toISOString(),
		});

		expect(first.text).toBe('First response.');
		expect(second.text).toBe('Second response.');
	});

	it('reuses an already committed interrupted-stream recovery after restart', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new InMemoryConversationStreamStore();
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/recovery-instance',
			identity: { agentName: 'assistant', instanceId: 'recovery-instance' },
			producerId: 'producer-1',
		});
		const timestamp = new Date().toISOString();
		await writer.append([
			{
				v: 1,
				id: 'record-created',
				type: 'conversation_created',
				conversationId: 'conversation-recovery',
				harness: 'default',
				session: 'default',
				timestamp,
				affinityKey: 'affinity-recovery',
				createdAt: timestamp,
			},
			{
				v: 1,
				id: 'record-user',
				type: 'user_message',
				conversationId: 'conversation-recovery',
				harness: 'default',
				session: 'default',
				timestamp,
				submissionId: 'submission-recovery',
				attemptId: 'attempt-recovery',
				messageId: 'entry_user',
				parentId: null,
				content: [{ type: 'text', text: 'Continue' }],
			},
			{
				v: 1,
				id: 'record-assistant-started',
				type: 'assistant_message_started',
				conversationId: 'conversation-recovery',
				harness: 'default',
				session: 'default',
				timestamp,
				submissionId: 'submission-recovery',
				attemptId: 'attempt-recovery',
				turnId: 'turn-recovery',
				messageId: 'entry_partial',
				parentId: 'entry_user',
				modelInfo: { api: 'faux', provider: provider.getModel().provider, model: 'reviewer' },
			},
			{
				v: 1,
				id: 'record-text-started',
				type: 'assistant_text_started',
				conversationId: 'conversation-recovery',
				harness: 'default',
				session: 'default',
				timestamp,
				submissionId: 'submission-recovery',
				attemptId: 'attempt-recovery',
				messageId: 'entry_partial',
				blockId: 'block_partial',
				blockIndex: 0,
			},
			{
				v: 1,
				id: 'record-text-delta',
				type: 'assistant_text_delta',
				conversationId: 'conversation-recovery',
				harness: 'default',
				session: 'default',
				timestamp,
				submissionId: 'submission-recovery',
				attemptId: 'attempt-recovery',
				messageId: 'entry_partial',
				blockId: 'block_partial',
				sequence: 0,
				delta: 'Partial',
			},
		], { submission: { submissionId: 'submission-recovery', attemptId: 'attempt-recovery' } });
		const ctx = createFlueContext({
			id: 'recovery-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel('reviewer') },
			createDefaultEnv: async () => createNoopSessionEnv(),
			conversationWriter: writer,
			attachmentStore: new InMemoryAttachmentStore(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const internal = getInternalSession(await harness.session());
		if (!internal) throw new Error('Expected internal session.');

		expect(await internal.recoverInterruptedStream({
			submissionId: 'submission-recovery',
			attemptId: 'attempt-recovery',
		}, 'turn-recovery')).toBe(true);
		const offset = writer.offset;
		expect(await internal.recoverInterruptedStream({
			submissionId: 'submission-recovery',
			attemptId: 'attempt-recovery',
		}, 'turn-recovery')).toBe(true);
		expect(writer.offset).toBe(offset);
	});

	it('reuses a durable attachment outcome when repairing an interrupted tool batch', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new InMemoryConversationStreamStore();
		const attachments = new InMemoryAttachmentStore();
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/tool-attachment-repair-instance',
			identity: { agentName: 'assistant', instanceId: 'tool-attachment-repair-instance' },
			producerId: 'producer-1',
		});
		const timestamp = new Date().toISOString();
		const bytes = Uint8Array.from([1, 2, 3]);
		const attachment = await createAttachmentRef({ id: 'att_tool_result', mimeType: 'image/png', bytes });
		await attachments.put({
			streamPath: writer.path,
			attachment,
			bytes,
			owner: { kind: 'conversation', conversationId: 'conversation-tool-repair' },
		});
		await writer.append([
			{
				v: 1,
				id: 'record-tool-created',
				type: 'conversation_created',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				affinityKey: 'affinity-tool-repair',
				createdAt: timestamp,
			},
			{
				v: 1,
				id: 'record-tool-user',
				type: 'user_message',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_user',
				parentId: null,
				content: [{ type: 'text', text: 'Use tools' }],
			},
			{
				v: 1,
				id: 'record-tool-assistant-started',
				type: 'assistant_message_started',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_assistant',
				parentId: 'entry_tool_user',
				modelInfo: { api: 'faux', provider: provider.getModel().provider, model: 'reviewer' },
			},
			{
				v: 1,
				id: 'record-tool-call',
				type: 'assistant_tool_call',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_assistant',
				blockId: 'block_tool',
				blockIndex: 0,
				toolCallId: 'tool-call-1',
				name: 'lookup',
				arguments: {},
			},
			{
				v: 1,
				id: 'record-tool-assistant-completed',
				type: 'assistant_message_completed',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_assistant',
				stopReason: 'toolUse',
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
			{
				v: 1,
				id: 'record-tool-outcome',
				type: 'tool_outcome',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				assistantMessageId: 'entry_tool_assistant',
				toolCallId: 'tool-call-1',
				toolName: 'lookup',
				isError: false,
				content: [{ type: 'attachment', attachment }],
			},
		]);
		const ctx = createFlueContext({
			id: 'tool-attachment-repair-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel('reviewer') },
			createDefaultEnv: async () => createNoopSessionEnv(),
			conversationWriter: writer,
			attachmentStore: attachments,
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const internal = getInternalSession(await harness.session());
		if (!internal) throw new Error('Expected internal session.');
		const repairedLeaf = await internal.repairInterruptedToolCalls(
			{
				kind: 'dispatch',
				submissionId: 'submission-tool-repair',
				dispatchId: 'submission-tool-repair',
				agent: 'assistant',
				id: 'tool-attachment-repair-instance',
				input: {},
				acceptedAt: timestamp,
			},
			{ toolCalls: [{ type: 'toolCall', id: 'tool-call-1', name: 'lookup' }] },
		);
		const repaired = await writer.getConversation('conversation-tool-repair');

		expect(repaired?.entries.get(repairedLeaf ?? '')).toMatchObject({
			type: 'message',
			attachmentRefs: new Map([[attachment.id, attachment]]),
		});
	});

	it('reuses an already committed interrupted-tool repair after restart', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new InMemoryConversationStreamStore();
		const writer = await ConversationRecordWriter.create({
			store,
			path: 'agents/assistant/tool-repair-instance',
			identity: { agentName: 'assistant', instanceId: 'tool-repair-instance' },
			producerId: 'producer-1',
		});
		const timestamp = new Date().toISOString();
		await writer.append([
			{
				v: 1,
				id: 'record-tool-created',
				type: 'conversation_created',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				affinityKey: 'affinity-tool-repair',
				createdAt: timestamp,
			},
			{
				v: 1,
				id: 'record-tool-user',
				type: 'user_message',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_user',
				parentId: null,
				content: [{ type: 'text', text: 'Use tools' }],
			},
			{
				v: 1,
				id: 'record-tool-assistant-started',
				type: 'assistant_message_started',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_assistant',
				parentId: 'entry_tool_user',
				modelInfo: { api: 'faux', provider: provider.getModel().provider, model: 'reviewer' },
			},
			{
				v: 1,
				id: 'record-tool-call',
				type: 'assistant_tool_call',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_assistant',
				blockId: 'block_tool',
				blockIndex: 0,
				toolCallId: 'tool-call-1',
				name: 'lookup',
				arguments: {},
			},
			{
				v: 1,
				id: 'record-tool-assistant-completed',
				type: 'assistant_message_completed',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				messageId: 'entry_tool_assistant',
				stopReason: 'toolUse',
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			},
			{
				v: 1,
				id: 'record-tool-outcome',
				type: 'tool_outcome',
				conversationId: 'conversation-tool-repair',
				harness: 'default',
				session: 'default',
				timestamp,
				assistantMessageId: 'entry_tool_assistant',
				toolCallId: 'tool-call-1',
				toolName: 'lookup',
				isError: false,
				content: [{ type: 'text', text: 'Known durable result' }],
			},
		]);
		const ctx = createFlueContext({
			id: 'tool-repair-instance',
			env: {},
			agentConfig: { resolveModel: () => provider.getModel('reviewer') },
			createDefaultEnv: async () => createNoopSessionEnv(),
			conversationWriter: writer,
			attachmentStore: new InMemoryAttachmentStore(),
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const internal = getInternalSession(await harness.session());
		if (!internal) throw new Error('Expected internal session.');
		const input = {
			kind: 'dispatch' as const,
			submissionId: 'submission-tool-repair',
			dispatchId: 'submission-tool-repair',
			agent: 'assistant',
			id: 'tool-repair-instance',
			input: {},
			acceptedAt: timestamp,
		};
		const request = { toolCalls: [{ type: 'toolCall' as const, id: 'tool-call-1', name: 'lookup' }] };
		const attempt = { submissionId: 'submission-tool-repair', attemptId: 'attempt-tool-repair' };

		const repairedLeaf = await internal.repairInterruptedToolCalls(input, request, attempt);
		const offset = writer.offset;
		expect(repairedLeaf).toMatch(/^entry_tool_repair_/);
		const repaired = await writer.getConversation('conversation-tool-repair');
		expect(repaired?.entries.get(repairedLeaf ?? '')).toMatchObject({
			type: 'message',
			message: {
				role: 'toolResult',
				isError: false,
				content: [{ type: 'text', text: 'Known durable result' }],
			},
		});
		expect(await internal.repairInterruptedToolCalls(input, request, attempt)).toBe(repairedLeaf);
		expect(writer.offset).toBe(offset);
	});

	it('correlates a model task tool call with its task start observation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const toolCallId = `tool:${crypto.randomUUID()}`;
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall('task', { prompt: 'Review the runtime package.' }, { id: toolCallId }),
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage('Runtime review complete.'),
			fauxAssistantMessage('Delegation complete.'),
		]);
		const ctx = createContext(provider);
		const observations: Array<{ type: string; toolCallId?: string }> = [];
		const stopObserving = observe((event, observedContext) => {
			if (observedContext === ctx && event.type === 'task_start') observations.push(event);
		});
		try {
			const harness = await ctx.initializeRootHarness(
				defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
			);

			await (await harness.session()).prompt('Delegate the review.');

			expect(observations).toEqual([
				expect.objectContaining({ type: 'task_start', toolCallId }),
			]);
		} finally {
			stopObserving();
		}
	});

	it('passes a visible parent image to the child when the task tool receives its attachment ID', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let attachmentId = '';
		provider.setResponses([
			(context) => {
				const prompt = context.messages[0];
				const text =
					prompt && Array.isArray(prompt.content)
						? prompt.content.find((block) => block.type === 'text')?.text
						: undefined;
				attachmentId = text?.match(/id="(att_[^"]+)"/)?.[1] ?? '';
				return fauxAssistantMessage(
					fauxToolCall('task', {
						prompt: 'Analyze the delegated image.',
						attachments: [{ id: attachmentId }],
					}),
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				expect(context.messages).toEqual([
					expect.objectContaining({
						role: 'user',
						content: expect.arrayContaining([
							expect.objectContaining({ type: 'text', text: 'Analyze the delegated image.' }),
							{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
						]),
					}),
				]);
				return fauxAssistantMessage('Image analyzed.');
			},
			fauxAssistantMessage('Delegation complete.'),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const response = await session.prompt('Delegate this image.', {
			images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
		});

		expect(attachmentId).toMatch(/^att_/);
		expect(response.text).toBe('Delegation complete.');
	});

	it('deduplicates repeated attachment IDs before passing images to the child', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let attachmentId = '';
		provider.setResponses([
			(context) => {
				const prompt = context.messages[0];
				const text =
					prompt && Array.isArray(prompt.content)
						? prompt.content.find((block) => block.type === 'text')?.text
						: undefined;
				attachmentId = text?.match(/id="(att_[^"]+)"/)?.[1] ?? '';
				return fauxAssistantMessage(
					fauxToolCall('task', {
						prompt: 'Analyze the delegated image.',
						attachments: [{ id: attachmentId }, { id: attachmentId }],
					}),
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				const prompt = context.messages[0];
				const images =
					prompt && Array.isArray(prompt.content)
						? prompt.content.filter((block) => block.type === 'image')
						: [];
				expect(images).toEqual([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
				return fauxAssistantMessage('Image analyzed once.');
			},
			fauxAssistantMessage('Delegation complete.'),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Delegate this image.', {
			images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
		});
	})

	it('deduplicates repeated attachment IDs before passing images to the child', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let attachmentId = '';
		provider.setResponses([
			(context) => {
				const prompt = context.messages[0];
				const text =
					prompt && Array.isArray(prompt.content)
						? prompt.content.find((block) => block.type === 'text')?.text
						: undefined;
				attachmentId = text?.match(/id="(att_[^"]+)"/)?.[1] ?? '';
				return fauxAssistantMessage(
					fauxToolCall('task', {
						prompt: 'Analyze the delegated image.',
						attachments: [{ id: attachmentId }, { id: attachmentId }],
					}),
					{ stopReason: 'toolUse' },
				);
			},
			(context) => {
				const prompt = context.messages[0];
				const images =
					prompt && Array.isArray(prompt.content)
						? prompt.content.filter((block) => block.type === 'image')
						: [];
				expect(images).toEqual([{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }]);
				return fauxAssistantMessage('Image analyzed once.');
			},
			fauxAssistantMessage('Delegation complete.'),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Delegate this image.', {
			images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
		});
	});

	it('returns a structured error without creating a child when the task tool receives an unavailable attachment ID', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let rejectedTaskResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall('task', {
					prompt: 'Analyze the delegated image.',
					attachments: [{ id: 'att_missing' }],
				}),
				{ stopReason: 'toolUse' },
			),
			(context) => {
				rejectedTaskResult = context.messages.at(-1);
				return fauxAssistantMessage('Handled missing attachment.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Delegate an unavailable image.');

		expect(rejectedTaskResult).toMatchObject({
			role: 'toolResult',
			toolName: 'task',
			isError: true,
			content: [
				{
					type: 'text',
					text: 'Attachment "att_missing" is not available in this session.',
				},
			],
		});
	});

	it('rejects an attachment ID after compaction removes its image from model context', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let attachmentId = '';
		let rejectedTaskResult: unknown;
		provider.setResponses([
			(context) => {
				const prompt = context.messages[0];
				const text =
					prompt && Array.isArray(prompt.content)
						? prompt.content.find((block) => block.type === 'text')?.text
						: undefined;
				attachmentId = text?.match(/id="([^"]+)"/)?.[1] ?? '';
				return fauxAssistantMessage('Stored image.');
			},
			fauxAssistantMessage('Recent response.'),
			fauxAssistantMessage('Summary without attachment IDs.'),
			fauxAssistantMessage('Validated summary without attachment IDs.'),
			() =>
				fauxAssistantMessage(
					fauxToolCall('task', {
						prompt: 'Analyze the compacted image.',
						attachments: [{ id: attachmentId }],
					}),
					{ stopReason: 'toolUse' },
				),
			(context) => {
				rejectedTaskResult = context.messages.at(-1);
				return fauxAssistantMessage('Handled compacted attachment.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reviewer`,
				compaction: { keepRecentTokens: 1 },
			})),
		);
		const session = await harness.session();
		await session.prompt('Store this image.', {
			images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
		});
		await session.prompt('Keep this recent message.');
		await session.compact();

		await session.prompt('Try the old attachment ID.');

		expect(rejectedTaskResult).toMatchObject({
			role: 'toolResult',
			toolName: 'task',
			isError: true,
			content: [
				{
					type: 'text',
					text: `Attachment "${attachmentId}" is not available in this session.`,
				},
			],
		});
	});

	it('rejects recursive delegation when delegation depth exceeds the supported limit', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let rejectedTaskResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Delegate depth two.' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Delegate depth three.' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Delegate depth four.' }), {
				stopReason: 'toolUse',
			}),
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Delegate past the maximum.' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				rejectedTaskResult = context.messages.at(-1);
				return fauxAssistantMessage('Stopped recursive delegation.');
			},
			fauxAssistantMessage('Depth three complete.'),
			fauxAssistantMessage('Depth two complete.'),
			fauxAssistantMessage('Depth one complete.'),
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const response = await session.task('Delegate depth one.');

		expect(response.text).toBe('Depth one complete.');
		expect(rejectedTaskResult).toMatchObject({
			role: 'toolResult',
			toolName: 'task',
			isError: true,
			content: [{ type: 'text', text: 'Maximum delegation depth (4) exceeded.' }],
		});
	});
});

describe('CallHandle', () => {
	it('rejects with AbortError when abort() cancels an active operation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		provider.setResponses([
			() => {
				markStarted();
				return fauxAssistantMessage('A response long enough to remain active during cancellation.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const operation = session.prompt('Begin a cancellable review.');
		await started;
		operation.abort('stop review');

		await expect(operation).rejects.toMatchObject({ name: 'AbortError', message: 'stop review' });
	});

	it('does not issue another model call when abort() interrupts retry backoff', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProvider([{ id: 'reviewer' }]);
			provider.setResponses([
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded_error' }),
				fauxAssistantMessage('Should not be requested.'),
			]);
			const ctx = createContext(provider);
			const harness = await ctx.initializeRootHarness(
				defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
			);
			const session = await harness.session();

			const operation = session.prompt('Begin a cancellable review.');
			const rejected = expect(operation).rejects.toMatchObject({
				name: 'AbortError',
				message: 'stop retrying',
			});
			await vi.waitFor(() => {
				expect(provider.state.callCount).toBe(1);
			});
			operation.abort('stop retrying');
			await vi.runAllTimersAsync();

			await rejected;
			expect(provider.state.callCount).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it('rejects with AbortError when an external signal cancels an active operation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		provider.setResponses([
			() => {
				markStarted();
				return fauxAssistantMessage('A response long enough to remain active during cancellation.');
			},
		]);
		const controller = new AbortController();
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const operation = session.prompt('Begin an externally cancellable review.', {
			signal: controller.signal,
		});
		await started;
		controller.abort('external stop');

		await expect(operation).rejects.toMatchObject({ name: 'AbortError', message: 'external stop' });
	});

	it('delivers the AbortError through .catch() and runs .finally() when abort() cancels an active operation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		provider.setResponses([
			() => {
				markStarted();
				return fauxAssistantMessage('A response long enough to remain active during cancellation.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const operation = session.prompt('Begin a cancellable review.');
		let finallyRan = false;
		const caught = operation.catch((error: unknown) => error);
		const settled = operation
			.finally(() => {
				finallyRan = true;
			})
			.catch(() => {});
		await started;
		operation.abort('stop review');

		await expect(caught).resolves.toMatchObject({ name: 'AbortError', message: 'stop review' });
		await settled;
		expect(finallyRan).toBe(true);
	});

	it('exposes an aborted signal when abort() cancels an active operation', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		provider.setResponses([
			() => {
				markStarted();
				return fauxAssistantMessage('A response long enough to remain active during cancellation.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const operation = session.prompt('Begin a cancellable review.');
		await started;
		operation.abort('inspect signal');

		expect(operation.signal.aborted).toBe(true);
		expect(operation.signal.reason).toBe('inspect signal');
		await expect(operation).rejects.toMatchObject({
			name: 'AbortError',
			message: 'inspect signal',
		});
	});

	it('does not emit an unhandled rejection when an unawaited handle is aborted and dropped', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		provider.setResponses([
			() => {
				markStarted();
				return fauxAssistantMessage('A response long enough to remain active during cancellation.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => {
			unhandled.push(reason);
		};
		process.on('unhandledRejection', onUnhandled);
		try {
			const operation = session.prompt('Begin a fire-and-forget review.');
			await started;
			operation.abort('cancelled without awaiting');

			// Unhandled rejections surface on later macrotask turns; give the
			// dropped handle several turns to settle before checking.
			for (let i = 0; i < 5; i++) {
				await new Promise<void>((resolve) => setImmediate(resolve));
			}
			expect(unhandled).toEqual([]);
			// Confirm the operation actually rejected, so the assertion above
			// could not pass vacuously.
			await expect(operation).rejects.toMatchObject({
				name: 'AbortError',
				message: 'cancelled without awaiting',
			});
		} finally {
			process.off('unhandledRejection', onUnhandled);
		}
	});
});
