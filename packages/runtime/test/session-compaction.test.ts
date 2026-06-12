import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent, SessionBusyError } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { FlueEvent } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

describe('session.compact()', () => {
	it('completes without changes when a session has nothing to compact', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'manual-empty-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(createAgent(() => ({ model: modelSpecifier })));
		const session = await harness.session();

		await expect(session.compact()).resolves.toBeUndefined();

		expect(provider.state.callCount).toBe(0);
		expect(events.some((event) => event.type === 'compaction_start')).toBe(false);
		expect(events.some((event) => event.type === 'compaction')).toBe(false);
	});

	it('emits manual compaction events when explicit compaction summarizes history', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		provider.setResponses([
			fauxAssistantMessage('old response'),
			fauxAssistantMessage('ok'),
			fauxAssistantMessage('summary checkpoint'),
		]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'manual-event-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({ model: modelSpecifier, compaction: { keepRecentTokens: 3 } })),
		);
		const session = await harness.session();
		await session.prompt('old marker');
		await session.prompt('recent marker');

		await session.compact();

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'compaction_start', reason: 'manual' }),
				expect.objectContaining({ type: 'compaction' }),
			]),
		);
		expect(
			events.some((event) => event.type === 'turn_request' && event.purpose === 'compaction'),
		).toBe(true);
	});

	it('rejects when summarization fails during explicit compaction', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		provider.setResponses([
			fauxAssistantMessage('old response'),
			fauxAssistantMessage('ok'),
			fauxAssistantMessage('', {
				stopReason: 'error',
				errorMessage: 'summarization provider unavailable',
			}),
		]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'manual-failed-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({ model: modelSpecifier, compaction: { keepRecentTokens: 3 } })),
		);
		const session = await harness.session();
		await session.prompt('old marker');
		await session.prompt('recent marker');

		await expect(session.compact()).rejects.toThrow();

		expect(events.some((event) => event.type === 'compaction' && event.isError)).toBe(true);
		expect(events.some((event) => event.type === 'compaction' && !event.isError)).toBe(false);
		expect(
			events.some(
				(event) =>
					event.type === 'operation' && event.operationKind === 'compact' && event.isError,
			),
		).toBe(true);
	});

	it('rejects explicit compaction when another session operation is active', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		let markStarted!: () => void;
		let releaseResponse!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const released = new Promise<void>((resolve) => {
			releaseResponse = resolve;
		});
		provider.setResponses([
			async () => {
				markStarted();
				await released;
				return fauxAssistantMessage('finished');
			},
		]);
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'manual-overlap-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		const harness = await ctx.init(createAgent(() => ({ model: modelSpecifier })));
		const session = await harness.session();
		const prompt = session.prompt('wait for completion');
		await started;

		try {
			await expect(session.compact()).rejects.toThrow(SessionBusyError);
		} finally {
			releaseResponse();
			await prompt;
		}
	});

	it('still runs explicit compaction when automatic threshold compaction is disabled', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		provider.setResponses([
			fauxAssistantMessage('old response'),
			fauxAssistantMessage('current response'),
			fauxAssistantMessage('summary checkpoint'),
		]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'manual-disabled-threshold-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({
				model: modelSpecifier,
				compaction: false,
			})),
		);
		const session = await harness.session();
		await session.prompt('old marker');
		await session.prompt('current context '.repeat(4000));

		await session.compact();

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'compaction_start', reason: 'manual' }),
				expect.objectContaining({ type: 'compaction' }),
			]),
		);
		expect(
			events.some((event) => event.type === 'turn_request' && event.purpose === 'compaction'),
		).toBe(true);
	});
});

describe('automatic compaction', () => {
	it('compacts conversation history when usage crosses the configured threshold', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
			models: [{ id: 'threshold', contextWindow: 100000, maxTokens: 10000 }],
		});
		providers.push(provider);
		provider.setResponses([fauxAssistantMessage('ok'), fauxAssistantMessage('summary checkpoint')]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'automatic-threshold-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({
				model: modelSpecifier,
				compaction: { reserveTokens: 100000, keepRecentTokens: 1 },
			})),
		);
		const session = await harness.session();

		await session.prompt('compact after this response');

		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'compaction_start', reason: 'threshold' }),
				expect.objectContaining({ type: 'compaction' }),
			]),
		);
		expect(events.some((event) => event.type === 'turn_request' && event.purpose !== 'agent')).toBe(
			true,
		);
	});

	it('skips threshold compaction when automatic compaction is disabled', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
			models: [{ id: 'threshold-disabled', contextWindow: 100000, maxTokens: 10000 }],
		});
		providers.push(provider);
		provider.setResponses([fauxAssistantMessage('ok')]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'automatic-threshold-disabled',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({
				model: modelSpecifier,
				compaction: false,
			})),
		);
		const session = await harness.session();

		await session.prompt('do not compact this response');

		expect(provider.state.callCount).toBe(1);
		expect(events.some((event) => event.type === 'compaction_start')).toBe(false);
		expect(events.some((event) => event.type === 'compaction')).toBe(false);
	});

	it('compacts and retries when the provider reports context overflow', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		provider.setResponses([
			fauxAssistantMessage('prior response'),
			fauxAssistantMessage('', {
				stopReason: 'error',
				errorMessage: 'Your input exceeds the context window of this model',
			}),
			fauxAssistantMessage('summary checkpoint'),
			fauxAssistantMessage('recovered response'),
		]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const store = new InMemorySessionStore();
		const save = vi.spyOn(store, 'save');
		const ctx = createFlueContext({
			id: 'overflow-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: store,
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({ model: modelSpecifier, compaction: { keepRecentTokens: 3 } })),
		);
		const session = await harness.session();
		await session.prompt('prior marker');

		const result = await session.prompt('current marker');

		expect(result.text).toBe('recovered response');
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'compaction_start', reason: 'overflow' }),
				expect.objectContaining({ type: 'compaction' }),
			]),
		);
		const data = save.mock.calls.at(-1)?.[1];
		expect(
			data?.entries.some(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'assistant' &&
					entry.message.stopReason === 'error',
			),
		).toBe(true);
	});

	it('still compacts and retries on context overflow when automatic threshold compaction is disabled', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		provider.setResponses([
			fauxAssistantMessage('prior response'),
			fauxAssistantMessage('', {
				stopReason: 'error',
				errorMessage: 'Your input exceeds the context window of this model',
			}),
			fauxAssistantMessage('summary checkpoint'),
			fauxAssistantMessage('recovered response'),
		]);
		const events: FlueEvent[] = [];
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'overflow-disabled-threshold-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({
				model: modelSpecifier,
				compaction: false,
			})),
		);
		const session = await harness.session();
		await session.prompt('prior marker');

		const result = await session.prompt('current context '.repeat(4000));

		expect(result.text).toBe('recovered response');
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: 'compaction_start', reason: 'overflow' }),
				expect.objectContaining({ type: 'compaction' }),
			]),
		);
	});

	it('includes the summary and recent unsummarized conversation in the next model request when older history is compacted', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
		});
		providers.push(provider);
		let nextMessages: unknown;
		provider.setResponses([
			fauxAssistantMessage('old response'),
			fauxAssistantMessage('ok'),
			fauxAssistantMessage('durable summary marker'),
			(context) => {
				nextMessages = context.messages;
				return fauxAssistantMessage('next response');
			},
		]);
		const model = provider.getModel();
		const modelSpecifier = `${model.provider}/${model.id}`;
		const ctx = createFlueContext({
			id: 'next-request-after-compaction',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => (requested === modelSpecifier ? model : undefined),
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		const harness = await ctx.init(
			createAgent(() => ({ model: modelSpecifier, compaction: { keepRecentTokens: 3 } })),
		);
		const session = await harness.session();
		await session.prompt('old marker');
		await session.prompt('recent marker');
		await session.compact();

		await session.prompt('next marker');

		expect(nextMessages).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					role: 'user',
					content: expect.arrayContaining([
						expect.objectContaining({
							type: 'text',
							text: expect.stringContaining('durable summary marker'),
						}),
					]),
				}),
				expect.objectContaining({
					role: 'user',
					content: expect.arrayContaining([
						expect.objectContaining({ type: 'text', text: 'recent marker' }),
					]),
				}),
				expect.objectContaining({
					role: 'assistant',
					content: [expect.objectContaining({ type: 'text', text: 'ok' })],
				}),
			]),
		);
	});

	it('uses the configured compaction model for summarization when a compaction model override is provided', async () => {
		const provider = registerFauxProvider({
			provider: `session-compaction-${crypto.randomUUID()}`,
			models: [{ id: 'agent' }, { id: 'summarizer' }],
		});
		providers.push(provider);
		provider.setResponses([
			fauxAssistantMessage('old response'),
			fauxAssistantMessage('ok'),
			fauxAssistantMessage('summary checkpoint'),
		]);
		const events: FlueEvent[] = [];
		const agentModel = provider.getModel('agent');
		const summarizerModel = provider.getModel('summarizer');
		if (!agentModel || !summarizerModel) throw new Error('Expected faux compaction models.');
		const agentModelSpecifier = `${agentModel.provider}/${agentModel.id}`;
		const summarizerModelSpecifier = `${summarizerModel.provider}/${summarizerModel.id}`;
		const ctx = createFlueContext({
			id: 'configured-compaction-model',
			payload: {},
			env: {},
			agentConfig: {
				resolveModel: (requested) => {
					if (requested === agentModelSpecifier) return agentModel;
					if (requested === summarizerModelSpecifier) return summarizerModel;
					return undefined;
				},
			},
			createDefaultEnv: async () => createNoopSessionEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await ctx.init(
			createAgent(() => ({
				model: agentModelSpecifier,
				compaction: { keepRecentTokens: 3, model: summarizerModelSpecifier },
			})),
		);
		const session = await harness.session();
		await session.prompt('old marker');
		await session.prompt('recent marker');

		await session.compact();

		expect(
			events
				.filter(
					(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
						event.type === 'turn_request' && event.purpose === 'agent',
				)
				.map((event) => event.model),
		).toEqual(['agent', 'agent']);
		expect(
			events
				.filter(
					(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
						event.type === 'turn_request' && event.purpose === 'compaction',
				)
				.map((event) => event.model),
		).toEqual(['summarizer']);
	});
});
