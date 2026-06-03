import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAgent, defineTool, Type } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `tool-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

function createContext(provider: FauxProviderRegistration) {
	return createFlueContext({
		id: 'tool-test-instance',
		payload: {},
		env: {},
		agentConfig: {
			systemPrompt: '',
			skills: {},
			model: undefined,
			resolveModel: () => provider.getModel(),
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		defaultStore: new InMemorySessionStore(),
	});
}

async function createSession(provider: FauxProviderRegistration) {
	const harness = await createContext(provider).init(
		createAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
	);
	return harness.session();
}

describe('defineTool()', () => {
	it('rejects a tool definition when its name is empty', () => {
		expect(() =>
			defineTool({
				name: '',
				description: 'Look up a value.',
				parameters: Type.Object({}),
				execute: async () => 'ok',
			}),
		).toThrow('name');
	});

	it('rejects a tool definition when its description is empty', () => {
		expect(() =>
			defineTool({
				name: 'lookup',
				description: '',
				parameters: Type.Object({}),
				execute: async () => 'ok',
			}),
		).toThrow('description');
	});

	it('rejects a tool definition when its parameter schema is missing', () => {
		expect(() =>
			defineTool({
				name: 'lookup',
				description: 'Look up a value.',
				execute: async () => 'ok',
			} as never),
		).toThrow('parameters');
	});

	it('rejects a tool definition when its execute callback is missing', () => {
		expect(() =>
			defineTool({
				name: 'lookup',
				description: 'Look up a value.',
				parameters: Type.Object({}),
			} as never),
		).toThrow('execute');
	});
});

describe('custom tools', () => {
	it('rejects a custom tool when an operation activates a name reserved by a built-in tool', async () => {
		const session = await createSession(createProvider());

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'bash',
						description: 'Run bash.',
						parameters: Type.Object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow('conflicts with a built-in tool');
	});

	it('rejects a custom activate_skill tool because its name is framework-reserved', async () => {
		const session = await createSession(createProvider());

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'activate_skill',
						description: 'Activate a skill.',
						parameters: Type.Object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow('conflicts with a built-in tool');
	});

	it('rejects duplicate custom tool names when an operation assembles its active tools', async () => {
		const provider = createProvider();
		const harness = await createContext(provider).init(
			createAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						parameters: Type.Object({}),
						execute: async () => 'ok',
					}),
				],
			})),
		);
		const session = await harness.session();

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up another value.',
						parameters: Type.Object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow('Duplicate custom tool name "lookup"');
	});

	it('exposes agent-level custom tools when a model operation begins', async () => {
		const provider = createProvider();
		const activeToolNames: string[] = [];
		provider.setResponses([
			(context) => {
				activeToolNames.push(...(context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage('Done.');
			},
		]);
		const harness = await createContext(provider).init(
			createAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						parameters: Type.Object({}),
						execute: async () => 'ok',
					}),
				],
			})),
		);
		const session = await harness.session();

		await session.prompt('List your tools.');

		expect(activeToolNames).toContain('lookup');
	});

	it('exposes call-level custom tools only when the receiving operation begins', async () => {
		const provider = createProvider();
		const activeToolNames: string[][] = [];
		provider.setResponses([
			(context) => {
				activeToolNames.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage('First response.');
			},
			(context) => {
				activeToolNames.push((context.tools ?? []).map((tool) => tool.name));
				return fauxAssistantMessage('Second response.');
			},
		]);
		const session = await createSession(provider);

		await session.prompt('Answer without the call tool.');
		await session.prompt('Answer with the call tool.', {
			tools: [
				defineTool({
					name: 'lookup',
					description: 'Look up a value.',
					parameters: Type.Object({}),
					execute: async () => 'ok',
				}),
			],
		});

		expect(activeToolNames[0]).not.toContain('lookup');
		expect(activeToolNames[1]).toContain('lookup');
	});

	it('forwards validated arguments and the operation abort signal when a model invokes a custom tool', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { count: '2' } as never), {
				stopReason: 'toolUse',
			}),
		]);
		let receivedArgs: Record<string, unknown> | undefined;
		let receivedSignal: AbortSignal | undefined;
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a count.',
			parameters: Type.Object({ count: Type.Number() }),
			execute: async (args, signal) => {
				receivedArgs = args;
				receivedSignal = signal;
				markStarted();
				await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
				return 'interrupted';
			},
		});
		const harness = await createContext(provider).init(
			createAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			})),
		);
		const session = await harness.session();

		const operation = session.prompt('Look up two values.');
		await started;
		operation.abort('stop');

		await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
		expect(receivedArgs).toEqual({ count: 2 });
		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(receivedSignal?.aborted).toBe(true);
	});

	it('returns callback output to the model when a custom tool completes', async () => {
		const provider = createProvider();
		const execute = vi.fn(async () => 'Found the requested value.');
		let modelToolResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { query: 'flue' }), { stopReason: 'toolUse' }),
			(context) => {
				modelToolResult = context.messages.at(-1);
				return fauxAssistantMessage('Lookup complete.');
			},
		]);
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			parameters: Type.Object({ query: Type.String() }),
			execute,
		});
		const harness = await createContext(provider).init(
			createAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			})),
		);
		const session = await harness.session();

		const result = await session.prompt('Look up flue.');

		expect(execute).toHaveBeenCalledWith({ query: 'flue' }, expect.any(AbortSignal));
		expect(modelToolResult).toMatchObject({
			role: 'toolResult',
			toolName: 'lookup',
			content: [{ type: 'text', text: 'Found the requested value.' }],
			isError: false,
		});
		expect(result.text).toBe('Lookup complete.');
	});
});
