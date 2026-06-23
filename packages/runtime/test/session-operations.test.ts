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
import {
	defineAgent,
	defineAgentProfile,
	defineTool,
	ModelNotConfiguredError,
	SessionBusyError,
	SubagentNotDeclaredError,
} from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import { MAX_IMAGE_DATA_LENGTH } from '../src/persisted-images.ts';
import type { SessionData, SessionEnv, SessionStore } from '../src/types.ts';
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
	options: { env?: SessionEnv; store?: SessionStore } = {},
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
		defaultStore: options.store ?? new InMemorySessionStore(),
	});
}

class RecordingSessionStore implements SessionStore {
	readonly records = new Map<string, SessionData>();

	async save(id: string, data: SessionData): Promise<void> {
		this.records.set(id, structuredClone(data));
	}

	async load(id: string): Promise<SessionData | null> {
		return structuredClone(this.records.get(id) ?? null);
	}

	async delete(id: string): Promise<void> {
		this.records.delete(id);
	}
}

describe('session.prompt()', () => {
	it('persists user input before provider inference begins when prompt() starts', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new RecordingSessionStore();
		provider.setResponses([
			(context) => {
				const data = [...store.records.values()][0];
				expect(data?.entries).toEqual([
					expect.objectContaining({
						message: expect.objectContaining({ role: 'user' }),
					}),
				]);
				expect(context.messages).toEqual([expect.objectContaining({ role: 'user' })]);
				return fauxAssistantMessage('Reviewed workspace.');
			},
		]);
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');
	});

	it('does not invoke the provider when persisting the user checkpoint fails', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new RecordingSessionStore();
		const save = store.save.bind(store);
		store.save = async (id, data) => {
			if (data.entries.some((entry) => entry.type === 'message' && entry.message.role === 'user')) {
				throw new Error('persist failed');
			}
			await save(id, data);
		};
		provider.setResponses([fauxAssistantMessage('Should not be requested.')]);
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await expect(session.prompt('Review this workspace.')).rejects.toThrow('persist failed');
		expect(provider.state.callCount).toBe(0);
	});

	it('rejects an oversized image without invoking the provider or poisoning the session when prompt() receives image data over the persistence limit', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new RecordingSessionStore();
		provider.setResponses([fauxAssistantMessage('Reviewed workspace.')]);
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await expect(
			session.prompt('Describe this image.', {
				images: [
					{
						type: 'image',
						data: 'a'.repeat(MAX_IMAGE_DATA_LENGTH + 1),
						mimeType: 'image/png',
					},
				],
			}),
		).rejects.toThrow(`Image data exceeds the ${MAX_IMAGE_DATA_LENGTH} character limit.`);
		expect(provider.state.callCount).toBe(0);

		const response = await session.prompt('Review this workspace.');
		expect(response.text).toBe('Reviewed workspace.');
		const data = [...store.records.values()].at(-1);
		expect(data?.entries).not.toContainEqual(
			expect.objectContaining({
				message: expect.objectContaining({
					content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]),
				}),
			}),
		);
	});

	it('does not duplicate a user checkpoint when the first save fails and the failure turn saves later', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new RecordingSessionStore();
		const save = store.save.bind(store);
		let failed = false;
		store.save = async (id, data) => {
			if (
				!failed &&
				data.entries.some((entry) => entry.type === 'message' && entry.message.role === 'user')
			) {
				failed = true;
				throw new Error('persist failed');
			}
			await save(id, data);
		};
		provider.setResponses([fauxAssistantMessage('Should not be requested.')]);
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await expect(session.prompt('Review this workspace.')).rejects.toThrow('persist failed');
		const data = [...store.records.values()][0];
		expect(
			data?.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user'),
		).toHaveLength(1);
		expect(
			data?.entries.filter(
				(entry) => entry.type === 'message' && entry.message.role === 'assistant',
			),
		).toHaveLength(1);
		expect(provider.state.callCount).toBe(0);
	});

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

	it('persists completed assistant output before the agent reaches idle when a prompt returns no tool calls', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const store = new RecordingSessionStore();
		const events: string[] = [];
		provider.setResponses([fauxAssistantMessage('Reviewed workspace.')]);
		const ctx = createContext(provider, { store });
		ctx.subscribeEvent((event) => {
			if (event.type === 'agent_end') {
				events.push('agent_end');
				const data = [...store.records.values()][0];
				expect(data?.entries).toEqual([
					expect.objectContaining({ message: expect.objectContaining({ role: 'user' }) }),
					expect.objectContaining({ message: expect.objectContaining({ role: 'assistant' }) }),
				]);
			}
			if (event.type === 'idle') events.push('idle');
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');

		expect(events).toEqual(['agent_end', 'idle']);
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
			const store = new RecordingSessionStore();
			const events: unknown[] = [];
			const ctx = createContext(provider, { store });
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
			const data = [...store.records.values()][0];
			expect(
				data?.entries.filter(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant',
				),
			).toHaveLength(2);
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
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();
		await expect(session.prompt('First attempt.')).rejects.toThrow('invalid_api_key');
		const data = [...store.records.values()][0];
		expect(
			data?.entries.filter(
				(entry) => entry.type === 'message' && entry.message.role === 'assistant',
			),
		).toEqual([
			expect.objectContaining({ message: expect.objectContaining({ stopReason: 'error' }) }),
		]);

		await expect(session.prompt('Try after configuration update.')).resolves.toMatchObject({
			text: 'Recovered after configuration update.',
		});

		expect(retryContext).toEqual([
			expect.objectContaining({ role: 'user' }),
			expect.objectContaining({ role: 'user' }),
		]);
	});

	it('omits an incomplete persisted tool-request group from later provider input while retaining canonical entries', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		let retryContext: unknown[] = [];
		provider.setResponses([
			(context) => {
				retryContext = context.messages;
				return fauxAssistantMessage('Recovered after interruption advisory.');
			},
		]);
		const store = new RecordingSessionStore();
		const timestamp = '2026-06-01T00:00:00.000Z';
		await store.save('agent-session:["session-operations-instance","default","default"]', {
			version: 7,
			affinityKey: 'aff_01KT3P3GZGFBCKHKMQ11A7H2HW',
			childSessions: [],
			entries: [
				{
					type: 'message',
					id: 'user-1',
					parentId: null,
					timestamp,
					message: {
						role: 'user',
						content: [{ type: 'text', text: 'Use the tool.' }],
						timestamp: 0,
					},
				},
				{
					type: 'message',
					id: 'assistant-1',
					parentId: 'user-1',
					timestamp,
					message: fauxAssistantMessage(fauxToolCall('lookup', { query: 'flue' }), {
						stopReason: 'toolUse',
					}),
				},
				{
					type: 'message',
					id: 'advisory-1',
					parentId: 'assistant-1',
					timestamp,
					message: {
						role: 'signal',
						type: 'submission_interrupted',
						content: 'Provider replay was not attempted.',
						attributes: {
							submissionId: 'sub-1',
							kind: 'direct',
							reason: 'interrupted_after_input_application',
						},
						timestamp: 0,
					},
				},
			],
			leafId: 'advisory-1',
			metadata: {},
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await expect(session.prompt('Try again.')).resolves.toMatchObject({
			text: 'Recovered after interruption advisory.',
		});

		expect(retryContext).toEqual([
			expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Use the tool.' }] }),
			expect.objectContaining({
				role: 'user',
				content: [
					{
						type: 'text',
						text: expect.stringContaining('submission_interrupted'),
					},
				],
			}),
			expect.objectContaining({ role: 'user', content: [{ type: 'text', text: 'Try again.' }] }),
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
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
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
		expect([...store.records.keys()].some((key) => key.includes('task:default:'))).toBe(false);
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
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
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
		expect([...store.records.keys()].some((key) => key.includes('task:default:'))).toBe(false);
	});

	it('preserves attachment identity after session state is reloaded', async () => {
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
				return fauxAssistantMessage('Stored image.');
			},
			() =>
				fauxAssistantMessage(
					fauxToolCall('task', {
						prompt: 'Analyze the stored image.',
						attachments: [{ id: attachmentId }],
					}),
					{ stopReason: 'toolUse' },
				),
			(context) => {
				expect(context.messages[0]).toMatchObject({
					role: 'user',
					content: expect.arrayContaining([
						{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
					]),
				});
				return fauxAssistantMessage('Reloaded image analyzed.');
			},
			fauxAssistantMessage('Delegation complete.'),
		]);
		const store = new RecordingSessionStore();
		const agent = defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` }));
		const firstContext = createContext(provider, { store });
		const firstHarness = await firstContext.initializeRootHarness(agent);
		const firstSession = await firstHarness.session();
		await firstSession.prompt('Store this image.', {
			images: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
		});
		const secondContext = createContext(provider, { store });
		const secondHarness = await secondContext.initializeRootHarness(agent);
		const secondSession = await secondHarness.session();

		const response = await secondSession.prompt('Delegate the stored image.');

		expect(response.text).toBe('Delegation complete.');
	});

	it('selects a declared subagent profile when task() receives an agent name', async () => {
		const provider = createProvider([{ id: 'parent-model' }, { id: 'delegate-model' }]);
		const selectedModels: string[] = [];
		provider.setResponses([
			(_context, _options, _state, model) => {
				selectedModels.push(model.id);
				return fauxAssistantMessage('Delegated profile response.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/parent-model`,
				subagents: [
					defineAgentProfile({
						name: 'code-reviewer',
						model: `${provider.getModel().provider}/delegate-model`,
						instructions: 'Review code changes only.',
					}),
				],
			})),
		);
		const session = await harness.session();

		const response = await session.task('Review the patch.', { agent: 'code-reviewer' });

		expect(selectedModels).toEqual(['delegate-model']);
		expect(response).toMatchObject({
			text: 'Delegated profile response.',
			model: { provider: provider.getModel().provider, id: 'delegate-model' },
		});
	});

	it('gives a subagent no parent tools or skills when its profile declares only name and instructions', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const delegatedToolNames: string[][] = [];
		provider.setResponses([
			(context) => {
				delegatedToolNames.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage('Summarized.');
			},
		]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reviewer`,
				tools: [
					defineTool({
						name: 'deploy_service',
						description: 'Deploys the production service.',
						input: v.object({}),
						run: async () => 'deployed',
					}),
				],
				skills: [{ name: 'release-runbook', description: 'Release process guidance.' }],
				subagents: [
					defineAgentProfile({
						name: 'summarizer',
						instructions: 'Summarize the supplied text in one line.',
					}),
				],
			})),
		);
		const session = await harness.session();

		const response = await session.task('Summarize this report.', { agent: 'summarizer' });

		expect(response.text).toBe('Summarized.');
		expect(delegatedToolNames).toHaveLength(1);
		expect(delegatedToolNames[0]).not.toContain('deploy_service');
		expect(delegatedToolNames[0]).not.toContain('activate_skill');
	});

	it('rejects an undeclared subagent when task() receives an unknown agent name', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const ctx = createContext(provider);
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/reviewer`,
				subagents: [defineAgentProfile({ name: 'declared-reviewer', model: false })],
			})),
		);
		const session = await harness.session();

		await expect(session.task('Review the patch.', { agent: 'missing-reviewer' })).rejects.toThrow(
			SubagentNotDeclaredError,
		);
		expect(provider.state.callCount).toBe(0);
	});

	it('scopes child work to a requested directory when task() receives a cwd', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const taskSystemPrompts: Array<string | undefined> = [];
		provider.setResponses([
			(context) => {
				taskSystemPrompts.push(context.systemPrompt);
				return fauxAssistantMessage('Scoped review complete.');
			},
		]);
		const ctx = createContext(provider, { env: createNoopSessionEnv({ cwd: '/repo' }) });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		const response = await session.task('Review the runtime package.', { cwd: 'packages/runtime' });

		expect(response.text).toBe('Scoped review complete.');
		expect(taskSystemPrompts).toHaveLength(1);
		expect(taskSystemPrompts[0]).toContain('Working directory: /repo/packages/runtime');
	});

	it('persists distinct opaque affinity keys for delegated task sessions', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		const providerSessionIds: Array<string | undefined> = [];
		provider.setResponses([
			(_context, options) => {
				providerSessionIds.push(options?.sessionId);
				return fauxAssistantMessage('Delegated response.');
			},
		]);
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.task('Review the persisted child state.');

		expect([...store.records.keys()]).toHaveLength(2);
		const parentRecord = store.records.get(
			'agent-session:["session-operations-instance","default","default"]',
		);
		const childEntry = [...store.records.entries()].find(([key]) => key.includes('task:default:'));
		expect(childEntry?.[0]).toMatch(
			/^agent-session:\["session-operations-instance","default","task:default:[^"]+"\]$/,
		);
		expect(parentRecord?.affinityKey).toMatch(/^aff_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(childEntry?.[1].affinityKey).toMatch(/^aff_[0-9A-HJKMNP-TV-Z]{26}$/);
		expect(childEntry?.[1].affinityKey).not.toBe(parentRecord?.affinityKey);
		expect(providerSessionIds).toEqual([childEntry?.[1].affinityKey]);
	});

	it('records retained delegated-task relationships before persisting child state', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([fauxAssistantMessage('Delegated response.')]);
		const store = new RecordingSessionStore();
		const save = store.save.bind(store);
		store.save = async (id, data) => {
			if (id.includes('task:default:')) {
				const parent = store.records.get(
					'agent-session:["session-operations-instance","default","default"]',
				);
				expect(parent?.childSessions).toContainEqual({
					type: 'task',
					session: expect.stringMatching(/^task:default:/),
					taskId: expect.any(String),
				});
			}
			await save(id, data);
		};
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.task('Review the persisted child state.');

		expect([...store.records.keys()]).toHaveLength(2);
	});

	it('retains every delegated-task relationship when parallel model tasks persist', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxToolCall('task', { prompt: 'Review the runtime package.' }),
					fauxToolCall('task', { prompt: 'Review the SDK package.' }),
				],
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage('Runtime review complete.'),
			fauxAssistantMessage('SDK review complete.'),
			fauxAssistantMessage('Both reviews complete.'),
		]);
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.prompt('Review both packages.');

		const parent = store.records.get(
			'agent-session:["session-operations-instance","default","default"]',
		);
		expect(parent?.childSessions).toHaveLength(2);
		expect(parent?.childSessions).toEqual([
			{
				type: 'task',
				session: expect.stringMatching(/^task:default:/),
				taskId: expect.any(String),
			},
			{
				type: 'task',
				session: expect.stringMatching(/^task:default:/),
				taskId: expect.any(String),
			},
		]);
	});

	it('removes persisted delegated-task state when the parent session is deleted', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([fauxAssistantMessage('Delegated response.')]);
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.task('Review the persisted child state.');

		expect([...store.records.keys()]).toHaveLength(2);
		expect([...store.records.keys()].some((key) => key.includes('task:default:'))).toBe(true);
		await session.delete();
		expect([...store.records.keys()]).toEqual([]);
	});

	it('derives recursive deletion keys from validated task relationships', async () => {
		const provider = createProvider([{ id: 'reviewer' }]);
		provider.setResponses([fauxAssistantMessage('Delegated response.')]);
		const store = new RecordingSessionStore();
		const ctx = createContext(provider, { store });
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({ model: `${provider.getModel().provider}/reviewer` })),
		);
		const session = await harness.session();

		await session.task('Review the persisted child state.');
		const parentKey = 'agent-session:["session-operations-instance","default","default"]';
		const unrelatedKey = 'agent-session:["session-operations-instance","default","unrelated"]';
		const parent = store.records.get(parentKey);
		const task = parent?.childSessions[0] as {
			type: 'task';
			session: string;
			taskId: string;
		};
		await store.save(unrelatedKey, {
			version: 7,
			affinityKey: 'aff_01J00000000000000000000000',
			entries: [],
			leafId: null,
			childSessions: [],
			metadata: {},
			createdAt: '2026-06-02T00:00:00.000Z',
			updatedAt: '2026-06-02T00:00:00.000Z',
		});
		task.session = 'unrelated';
		await store.save(parentKey, parent as SessionData);

		await session.delete();

		// The tampered relationship fails the task-session name validation, so
		// the cascade does not follow it into the unrelated session.
		expect(store.records.has(unrelatedKey)).toBe(true);
		expect(store.records.has(parentKey)).toBe(false);
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
