import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResultUnavailableError } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { FlueEvent, FlueSession, Skill } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `structured-results-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

async function createSession(
	provider: FauxProviderRegistration,
	options: { skills?: Skill[]; onEvent?: (event: FlueEvent) => void } = {},
): Promise<FlueSession> {
	const ctx = createFlueContext({
		id: 'structured-results-instance',
		payload: {},
		env: {},
		agentConfig: {
			resolveModel: () => provider.getModel(),
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		defaultStore: new InMemorySessionStore(),
	});
	if (options.onEvent) ctx.setEventCallback(options.onEvent);
	const harness = await ctx.init(
		{
			model: `${provider.getModel().provider}/${provider.getModel().id}`,
			skills: options.skills,
		},
	);
	return harness.session();
}

describe('structured operation results', () => {
	it('returns validated data when an operation receives a result schema', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('finish', { answer: 'Paris', confidence: 0.98 }), {
				stopReason: 'toolUse',
			}),
		]);
		const session = await createSession(provider);

		const response = await session.prompt('Name the capital of France.', {
			result: v.object({
				answer: v.string(),
				confidence: v.number(),
			}),
		});

		expect(response.data).toEqual({ answer: 'Paris', confidence: 0.98 });
		expect(response.model).toEqual({
			provider: provider.getModel().provider,
			id: provider.getModel().id,
		});
	});

	it('returns validated data when the first structured model turn fails transiently', async () => {
		vi.useFakeTimers();
		try {
			const provider = createProvider();
			provider.setResponses([
				fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'overloaded_error' }),
				fauxAssistantMessage(fauxToolCall('finish', { answer: 'Paris' }), {
					stopReason: 'toolUse',
				}),
			]);
			const session = await createSession(provider);

			const response = session.prompt('Name the capital of France.', {
				result: v.object({ answer: v.string() }),
			});
			await vi.advanceTimersByTimeAsync(2_000);

			await expect(response).resolves.toMatchObject({ data: { answer: 'Paris' } });
			expect(provider.state.callCount).toBe(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it('accepts an unwrapped payload when the result schema is a strictObject', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('finish', { verdict: 'approved' }), {
				stopReason: 'toolUse',
			}),
		]);
		const session = await createSession(provider);

		const response = await session.prompt('Review the request.', {
			result: v.strictObject({ verdict: v.string() }),
		});

		expect(response.data).toEqual({ verdict: 'approved' });
	});

	it('returns validated scalar data when a structured result schema is not an object', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('finish', { result: 'approved' }), {
				stopReason: 'toolUse',
			}),
		]);
		const session = await createSession(provider, {
			skills: [{ name: 'classify', description: 'Classify the request.' }],
		});

		const response = await session.skill('classify', {
			result: v.picklist(['approved', 'rejected']),
		});

		expect(response.data).toBe('approved');
	});

	it('allows a later structured-result submission when the model ends an earlier turn without finishing', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage('I need to finish this.'),
			fauxAssistantMessage(fauxToolCall('finish', { summary: 'Delegated review complete.' }), {
				stopReason: 'toolUse',
			}),
		]);
		const session = await createSession(provider);

		const response = await session.task('Review the delegated request.', {
			result: v.object({ summary: v.string() }),
		});

		expect(response.data).toEqual({ summary: 'Delegated review complete.' });
		expect(provider.state.callCount).toBe(2);
	});

	it('returns corrected validated data when the model resubmits after schema validation rejects an earlier result', async () => {
		const provider = createProvider();
		let validationResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('finish', { count: -1 }), { stopReason: 'toolUse' }),
			(context) => {
				validationResult = context.messages.at(-1);
				return fauxAssistantMessage(fauxToolCall('finish', { count: 2 }), {
					stopReason: 'toolUse',
				});
			},
		]);
		const session = await createSession(provider);

		const response = await session.prompt('Count the accepted entries.', {
			result: v.object({ count: v.pipe(v.number(), v.minValue(0)) }),
		});

		expect(validationResult).toMatchObject({
			role: 'toolResult',
			toolName: 'finish',
			isError: true,
		});
		expect(response.data).toEqual({ count: 2 });
		expect(provider.state.callCount).toBe(2);
	});

	it('throws ResultUnavailableError when the model gives up', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(
				[
					fauxText('The source material is unavailable.'),
					fauxToolCall('give_up', { reason: 'The source material is unavailable.' }),
				],
				{ stopReason: 'toolUse' },
			),
		]);
		const session = await createSession(provider);

		await expect(
			session.prompt('Summarize the source material.', {
				result: v.object({ summary: v.string() }),
			}),
		).rejects.toMatchObject({
			name: 'ResultUnavailableError',
			message: 'The agent gave up: The source material is unavailable.',
			reason: 'The source material is unavailable.',
			assistantText: 'The source material is unavailable.',
		});
	});

	it('throws ResultUnavailableError when the retry ceiling is exhausted', async () => {
		const provider = createProvider();
		provider.setResponses(
			Array.from({ length: 100 }, () => fauxAssistantMessage('Still working without submitting.')),
		);
		const session = await createSession(provider);

		let error: unknown;
		try {
			await session.prompt('Submit a final answer.', {
				result: v.object({ answer: v.string() }),
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(ResultUnavailableError);
		expect(error).toMatchObject({
			message: expect.stringContaining('Agent did not call `finish` or `give_up`'),
			assistantText: 'Still working without submitting.',
		});
		expect(provider.state.callCount).toBeGreaterThan(0);
		expect(provider.state.callCount).toBeLessThan(100);
	});

	it('aggregates usage across retries when structured output requires multiple turns', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage('I will submit on the next turn.'),
			fauxAssistantMessage(fauxToolCall('finish', { answer: 'complete' }), {
				stopReason: 'toolUse',
			}),
		]);
		const turns: Extract<FlueEvent, { type: 'turn' }>[] = [];
		const session = await createSession(provider, {
			onEvent: (event) => {
				if (event.type === 'turn') turns.push(event);
			},
		});

		const response = await session.prompt('Complete the structured response.', {
			result: v.object({ answer: v.string() }),
		});

		expect(turns).toHaveLength(2);
		expect(response.data).toEqual({ answer: 'complete' });
		expect(response.usage).toEqual({
			input: (turns[0]?.usage?.input ?? 0) + (turns[1]?.usage?.input ?? 0),
			output: (turns[0]?.usage?.output ?? 0) + (turns[1]?.usage?.output ?? 0),
			cacheRead: (turns[0]?.usage?.cacheRead ?? 0) + (turns[1]?.usage?.cacheRead ?? 0),
			cacheWrite: (turns[0]?.usage?.cacheWrite ?? 0) + (turns[1]?.usage?.cacheWrite ?? 0),
			totalTokens: (turns[0]?.usage?.totalTokens ?? 0) + (turns[1]?.usage?.totalTokens ?? 0),
			cost: {
				input: (turns[0]?.usage?.cost.input ?? 0) + (turns[1]?.usage?.cost.input ?? 0),
				output: (turns[0]?.usage?.cost.output ?? 0) + (turns[1]?.usage?.cost.output ?? 0),
				cacheRead: (turns[0]?.usage?.cost.cacheRead ?? 0) + (turns[1]?.usage?.cost.cacheRead ?? 0),
				cacheWrite:
					(turns[0]?.usage?.cost.cacheWrite ?? 0) + (turns[1]?.usage?.cost.cacheWrite ?? 0),
				total: (turns[0]?.usage?.cost.total ?? 0) + (turns[1]?.usage?.cost.total ?? 0),
			},
		});
	});
});
