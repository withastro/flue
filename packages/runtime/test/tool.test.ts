import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineTool, ToolNameConflictError } from '../src/index.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { SessionData, SessionStore } from '../src/types.ts';
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

function createContext(
	provider: FauxProviderRegistration,
	store: SessionStore = new InMemorySessionStore(),
) {
	return createFlueContext({
		id: 'tool-test-instance',
		payload: {},
		env: {},
		agentConfig: {
			resolveModel: () => provider.getModel(),
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		defaultStore: store,
	});
}

async function createSession(provider: FauxProviderRegistration) {
	const harness = await createContext(provider).init(
		{ model: `${provider.getModel().provider}/${provider.getModel().id}` },
	);
	return harness.session();
}

describe('defineTool()', () => {
	it('rejects a tool definition when its name is empty', () => {
		expect(() =>
			defineTool({
				name: '',
				description: 'Look up a value.',
				parameters: v.object({}),
				execute: async () => 'ok',
			}),
		).toThrow('name');
	});

	it('rejects a tool definition when its description is empty', () => {
		expect(() =>
			defineTool({
				name: 'lookup',
				description: '',
				parameters: v.object({}),
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
				parameters: v.object({}),
			} as never),
		).toThrow('execute');
	});

	it('rejects a valibot parameters schema when its top level is not an object', () => {
		expect(() =>
			defineTool({
				name: 'lookup',
				description: 'Look up a value.',
				parameters: v.string(),
				execute: async () => 'ok',
			}),
		).toThrow('top-level object schema');
	});

	it('throws with Standard Schema issues when execute arguments fail the valibot schema', async () => {
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up an order.',
			parameters: v.object({
				orderId: v.pipe(
					v.string(),
					v.check((id) => id.startsWith('order_'), 'Order IDs start with "order_".'),
				),
			}),
			execute: async () => 'ok',
		});

		await expect(lookup.execute({ orderId: 'invoice_7' })).rejects.toMatchObject({
			type: 'tool_input_validation',
			meta: {
				tool: 'lookup',
				issues: [{ message: 'Order IDs start with "order_".', path: ['orderId'] }],
			},
		});
	});

	it('applies valibot defaults and transforms before execute receives arguments', async () => {
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up recent values.',
			parameters: v.object({ limit: v.optional(v.number(), 10) }),
			execute: async ({ limit }) => `limit:${limit}`,
		});

		await expect(lookup.execute({})).resolves.toBe('limit:10');
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
						parameters: v.object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow(ToolNameConflictError);
	});

	it('rejects a custom activate_skill tool because its name is framework-reserved', async () => {
		const session = await createSession(createProvider());

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'activate_skill',
						description: 'Activate a skill.',
						parameters: v.object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow(ToolNameConflictError);
	});

	it('rejects a custom finish tool because its name is reserved for result capture', async () => {
		const session = await createSession(createProvider());

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'finish',
						description: 'Finish the order.',
						parameters: v.object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow(ToolNameConflictError);
	});

	it('rejects duplicate custom tool names when an operation assembles its active tools', async () => {
		const provider = createProvider();
		const harness = await createContext(provider).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						parameters: v.object({}),
						execute: async () => 'ok',
					}),
				],
			},
		);
		const session = await harness.session();

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up another value.',
						parameters: v.object({}),
						execute: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow(ToolNameConflictError);
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
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						parameters: v.object({}),
						execute: async () => 'ok',
					}),
				],
			},
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
					parameters: v.object({}),
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
			parameters: v.object({ count: v.number() }),
			execute: async (args, signal) => {
				receivedArgs = args;
				receivedSignal = signal;
				markStarted();
				await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
				return 'interrupted';
			},
		});
		const harness = await createContext(provider).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			},
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

	it('persists a completed tool-result batch before requesting follow-up inference', async () => {
		const provider = createProvider();
		const store = new RecordingSessionStore();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { query: 'flue' }), { stopReason: 'toolUse' }),
			(context) => {
				const data = [...store.records.values()][0];
				expect(data?.entries).toEqual([
					expect.objectContaining({ message: expect.objectContaining({ role: 'user' }) }),
					expect.objectContaining({
						message: expect.objectContaining({ role: 'assistant', stopReason: 'toolUse' }),
					}),
					expect.objectContaining({
						message: expect.objectContaining({ role: 'toolResult', toolName: 'lookup' }),
					}),
				]);
				expect(context.messages.at(-1)).toMatchObject({ role: 'toolResult', toolName: 'lookup' });
				return fauxAssistantMessage('Lookup complete.');
			},
		]);
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			parameters: v.object({ query: v.string() }),
			execute: async () => 'Found the requested value.',
		});
		const harness = await createContext(provider, store).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			},
		);
		const session = await harness.session();

		await expect(session.prompt('Look up flue.')).resolves.toMatchObject({
			text: 'Lookup complete.',
		});
	});

	it('does not begin a follow-up provider turn when persisting the completed prior turn fails', async () => {
		const provider = createProvider();
		const store = new RecordingSessionStore();
		const save = store.save.bind(store);
		store.save = async (id, data) => {
			if (
				data.entries.some(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'toolResult' &&
						entry.message.toolName === 'lookup',
				)
			) {
				throw new Error('persist failed');
			}
			await save(id, data);
		};
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { query: 'flue' }), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Should not be requested.'),
		]);
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			parameters: v.object({ query: v.string() }),
			execute: async () => 'Found the requested value.',
		});
		const harness = await createContext(provider, store).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			},
		);
		const session = await harness.session();

		await expect(session.prompt('Look up flue.')).rejects.toThrow('persist failed');
		expect(provider.state.callCount).toBe(1);
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
			parameters: v.object({ query: v.string() }),
			execute,
		});
		const harness = await createContext(provider).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			},
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

	it('exposes valibot parameters to the provider as one stable plain JSON Schema object', async () => {
		const provider = createProvider();
		const parameterSchemas: unknown[] = [];
		provider.setResponses([
			(context) => {
				parameterSchemas.push(context.tools?.find((tool) => tool.name === 'lookup')?.parameters);
				return fauxAssistantMessage('First.');
			},
			(context) => {
				parameterSchemas.push(context.tools?.find((tool) => tool.name === 'lookup')?.parameters);
				return fauxAssistantMessage('Second.');
			},
		]);
		const harness = await createContext(provider).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						parameters: v.object({ query: v.string() }),
						execute: async () => 'ok',
					}),
				],
			},
		);
		const session = await harness.session();

		await session.prompt('First prompt.');
		await session.prompt('Second prompt.');

		expect(parameterSchemas[0]).toEqual({
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
		});
		// Same object identity across turns: the agent loop caches compiled
		// argument validators keyed by schema identity.
		expect(parameterSchemas[1]).toBe(parameterSchemas[0]);
	});

	it('returns a schema error to the model instead of calling execute when arguments fail valibot validation', async () => {
		const provider = createProvider();
		const execute = vi.fn(async () => 'ok');
		let modelToolResult: unknown;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { orderId: 'invoice_7' }), {
				stopReason: 'toolUse',
			}),
			(context) => {
				modelToolResult = context.messages.at(-1);
				return fauxAssistantMessage('Understood, correcting.');
			},
		]);
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up an order.',
			parameters: v.object({
				orderId: v.pipe(
					v.string(),
					v.check((id) => id.startsWith('order_'), 'Order IDs start with "order_".'),
				),
			}),
			execute,
		});
		const harness = await createContext(provider).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			},
		);
		const session = await harness.session();

		const result = await session.prompt('Look up invoice_7.');

		expect(execute).not.toHaveBeenCalled();
		expect(modelToolResult).toMatchObject({
			role: 'toolResult',
			toolName: 'lookup',
			isError: true,
			content: [
				{
					type: 'text',
					text: expect.stringContaining('Order IDs start with "order_". (at orderId)'),
				},
			],
		});
		expect(result.text).toBe('Understood, correcting.');
	});

	it('passes raw JSON Schema parameters through unchanged when a tool uses the escape hatch', async () => {
		const provider = createProvider();
		const rawSchema = {
			type: 'object',
			properties: { query: { type: 'string', description: 'Search query.' } },
			required: ['query'],
			additionalProperties: false,
		};
		let providerSchema: unknown;
		let receivedArgs: unknown;
		provider.setResponses([
			(context) => {
				providerSchema = context.tools?.find((tool) => tool.name === 'lookup')?.parameters;
				return fauxAssistantMessage(fauxToolCall('lookup', { query: 'flue' }), {
					stopReason: 'toolUse',
				});
			},
			fauxAssistantMessage('Done.'),
		]);
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			parameters: rawSchema,
			execute: async (args) => {
				receivedArgs = args;
				return 'ok';
			},
		});
		const harness = await createContext(provider).init(
			{
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			},
		);
		const session = await harness.session();

		await session.prompt('Look up flue.');

		expect(providerSchema).toBe(rawSchema);
		expect(receivedArgs).toEqual({ query: 'flue' });
	});
});
