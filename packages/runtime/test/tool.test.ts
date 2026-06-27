import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	defineAgent,
	defineTool,
	instrument,
	observe,
	ToolLegacyDefinitionError,
	ToolNameConflictError,
	type FlueExecutionContext,
	type FlueExecutionOperation,
	type ToolInput,
	type ToolOutput,
} from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import { validateAndRunTool } from '../src/tool.ts';
import type { FlueEvent, FlueObservation } from '../src/types.ts';
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
		env: {},
		agentConfig: { resolveModel: () => provider.getModel() },
		createDefaultEnv: async () => createNoopSessionEnv(),
	});
}

async function createSession(provider: FauxProviderRegistration) {
	const harness = await createContext(provider).initializeRootHarness(
		defineAgent(() => ({ model: `${provider.getModel().provider}/${provider.getModel().id}` })),
	);
	return harness.session();
}

describe('defineTool()', () => {
	it('infers transformed input and output types when schemas are declared', () => {
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			input: v.object({ count: v.pipe(v.string(), v.transform(Number)) }),
			output: v.pipe(v.number(), v.transform(String)),
			run({ input, signal }) {
				expectTypeOf(input).toEqualTypeOf<{ count: number }>();
				expectTypeOf(signal).toEqualTypeOf<AbortSignal | undefined>();
				return input.count;
			},
		});

		expectTypeOf<ToolInput<typeof tool>>().toEqualTypeOf<{ count: string }>();
		expectTypeOf<ToolOutput<typeof tool>>().toEqualTypeOf<string>();
	});

	it('omits input from run context when no input schema is declared', () => {
		defineTool({
			name: 'refresh',
			description: 'Refresh values.',
			run(context) {
				expectTypeOf(context).not.toHaveProperty('input');
				return undefined;
			},
		});
	});

	it('rejects explicitly undefined legacy markers with structured fields', () => {
		let thrown: unknown;
		try {
			defineTool({
				name: 'lookup',
				description: 'Look up a value.',
				run: async () => 'ok',
				parameters: undefined,
				execute: undefined,
			} as never);
		} catch (error) {
			thrown = error;
		}

		expect(thrown).toBeInstanceOf(ToolLegacyDefinitionError);
		expect(thrown).toMatchObject({
			type: 'tool_legacy_definition',
			details: 'The tool definition contains legacy fields.',
			meta: { fields: ['parameters', 'execute'] },
		});
	});

	it('rejects a non-object input schema when input is declared', () => {
		expect(() =>
			defineTool({
				name: 'lookup',
				description: 'Look up a value.',
				input: v.string() as never,
				run: async () => 'ok',
			}),
		).toThrow('top-level object schema');
	});

	it('applies input defaults and transforms before run receives input', async () => {
		const run = vi.fn(({ input }: { input: { limit: number } }) => input.limit);
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up recent values.',
			input: v.object({
				limit: v.optional(v.pipe(v.string(), v.transform(Number)), '10'),
			}),
			run,
		});

		await expect(validateAndRunTool(tool, {})).resolves.toBe(10);
		expect(run).toHaveBeenCalledWith({
			input: { limit: 10 },
			signal: undefined,
		});
	});

	it('throws structured issues when input validation fails', async () => {
		const run = vi.fn(async () => 'ok');
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up an order.',
			input: v.object({
				orderId: v.pipe(
					v.string(),
					v.check((id) => id.startsWith('order_'), 'Order IDs start with "order_".'),
				),
			}),
			run,
		});

		await expect(validateAndRunTool(tool, { orderId: 'invoice_7' })).rejects.toMatchObject({
			type: 'tool_input_validation',
			meta: {
				tool: 'lookup',
				issues: [{ message: 'Order IDs start with "order_".', path: ['orderId'] }],
			},
		});
		expect(run).not.toHaveBeenCalled();
	});

	it('applies output transforms before returning output', async () => {
		const tool = defineTool({
			name: 'count',
			description: 'Count values.',
			output: v.pipe(v.number(), v.transform((count) => ({ count }))),
			run: async () => 2,
		});

		await expect(validateAndRunTool(tool, {})).resolves.toEqual({ count: 2 });
	});

	it('throws structured issues when output validation fails', async () => {
		const tool = defineTool({
			name: 'count',
			description: 'Count values.',
			output: v.number(),
			run: async () => 'two' as never,
		});

		await expect(validateAndRunTool(tool, {})).rejects.toMatchObject({
			type: 'tool_output_validation',
			meta: { tool: 'count', issues: [expect.objectContaining({ message: expect.any(String) })] },
		});
	});

	it('rejects undefined produced by a cast declared output schema at runtime', async () => {
		const tool = defineTool({
			name: 'undefined_output',
			description: 'Produces undefined despite a declared output.',
			output: v.undefined() as never,
			run: async () => undefined as never,
		});

		await expect(validateAndRunTool(tool)).rejects.toMatchObject({
			type: 'tool_output_serialization',
			meta: { tool: 'undefined_output' },
		});
	});

	it('rejects values that JSON.stringify would silently discard', async () => {
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			run: async () => ({ kept: true, discarded: undefined }) as never,
		});

		await expect(validateAndRunTool(tool, {})).rejects.toMatchObject({
			type: 'tool_output_serialization',
			meta: { tool: 'lookup' },
		});
	});

	it('returns a detached JSON snapshot of output', async () => {
		const output = { nested: { count: 1 } };
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			run: async () => output,
		});

		const result = await validateAndRunTool(tool, {});
		output.nested.count = 2;

		expect(result).toEqual({ nested: { count: 1 } });
		expect(result).not.toBe(output);
	});
});

describe('custom tools', () => {
	it('emits one lifecycle and execution interception for a builtin tool', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('bash', { command: 'pwd' }), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const events: FlueEvent[] = [];
		const observations: FlueObservation[] = [];
		const intercepted: FlueExecutionOperation[] = [];
		const context = createContext(provider);
		context.subscribeEvent((event) => {
			events.push(event);
		});
		const dispose = instrument({
			observe(event, observedContext) {
				if (observedContext === context) observations.push(event);
			},
			async interceptor(operation, _context, next) {
				intercepted.push(operation);
				return next();
			},
			dispose() {},
		});
		try {
			const harness = await context.initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
				})),
			);

			await (await harness.session()).prompt('Check the directory.');

			const lifecycle = events.filter(
				(event) => (event.type === 'tool_start' || event.type === 'tool') && event.toolName === 'bash',
			);
			const observedStart = observations.find(
				(event) => event.type === 'tool_start' && event.toolName === 'bash',
			);
			expect(lifecycle).toHaveLength(2);
			expect(observedStart).toMatchObject({ args: { command: 'pwd' } });
			expect(lifecycle[0]).not.toHaveProperty('args');
			expect(lifecycle[1]).toMatchObject({ type: 'tool', isError: false });
			expect(intercepted.filter((operation) => operation.type === 'tool')).toHaveLength(1);
		} finally {
			await dispose();
		}
	});

	it('emits one lifecycle and execution interception with transformed input', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { limit: '2' }), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const events: FlueEvent[] = [];
		const observations: FlueObservation[] = [];
		const intercepted: FlueExecutionOperation[] = [];
		const context = createContext(provider);
		context.subscribeEvent((event) => {
			events.push(event);
		});
		const dispose = instrument({
			observe(event, observedContext) {
				if (observedContext === context) observations.push(event);
			},
			async interceptor(operation, _context, next) {
				intercepted.push(operation);
				return next();
			},
			dispose() {},
		});
		try {
			const harness = await context.initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					tools: [
						defineTool({
							name: 'lookup',
							description: 'Look up values.',
							input: v.object({ limit: v.pipe(v.string(), v.transform(Number)) }),
							run: async ({ input }) => input.limit,
						}),
					],
				})),
			);

			await (await harness.session()).prompt('Look up values.');

			const lifecycle = events.filter(
				(event) =>
					(event.type === 'tool_start' || event.type === 'tool') && event.toolName === 'lookup',
			);
			const observedStart = observations.find(
				(event) => event.type === 'tool_start' && event.toolName === 'lookup',
			);
			expect(lifecycle).toHaveLength(2);
			expect(observedStart).toMatchObject({ args: { limit: 2 } });
			expect(lifecycle[0]).not.toHaveProperty('args');
			expect(lifecycle[1]).toMatchObject({ type: 'tool', isError: false });
			expect(intercepted.filter((operation) => operation.type === 'tool')).toHaveLength(1);
		} finally {
			await dispose();
		}
	});

	it('emits a start without args and skips execution interception when validation fails', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { count: 'invalid' }), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const events: FlueEvent[] = [];
		const observations: FlueObservation[] = [];
		const intercepted: FlueExecutionOperation[] = [];
		const context = createContext(provider);
		context.subscribeEvent((event) => {
			events.push(event);
		});
		const dispose = instrument({
			observe(event, observedContext) {
				if (observedContext === context) observations.push(event);
			},
			async interceptor(operation, _context, next) {
				intercepted.push(operation);
				return next();
			},
			dispose() {},
		});
		try {
			const harness = await context.initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					tools: [
						defineTool({
							name: 'lookup',
							description: 'Look up values.',
							input: v.object({
								count: v.pipe(
									v.string(),
									v.check((value) => value === 'valid'),
								),
							}),
							run: async () => 'unused',
						}),
					],
				})),
			);

			await (await harness.session()).prompt('Look up values.');

			const start = events.find(
				(event) => event.type === 'tool_start' && event.toolName === 'lookup',
			);
			expect(start).toBeDefined();
			expect(start).not.toHaveProperty('args');
			const results = events.filter(
				(event) => event.type === 'tool' && event.toolName === 'lookup',
			);
			const observedResult = observations.find(
				(event) => event.type === 'tool' && event.toolName === 'lookup',
			);
			expect(results).toEqual([expect.objectContaining({ isError: true })]);
			expect(observedResult).toMatchObject({
				errorInfo: {
					type: 'tool_input_validation',
					name: 'ToolInputValidationError',
					message: expect.any(String),
				},
			});
			expect(results[0]).not.toHaveProperty('errorInfo');
			expect(intercepted.filter((operation) => operation.type === 'tool')).toEqual([]);
		} finally {
			await dispose();
		}
	});

	it('emits a lifecycle without args when Pi rejects tool input before execution', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { count: 'invalid' }), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const events: FlueEvent[] = [];
		const context = createContext(provider);
		context.subscribeEvent((event) => {
			events.push(event);
		});
		const harness = await context.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up values.',
						input: v.object({ count: v.number() }),
						run: async () => 'unused',
					}),
				],
			})),
		);

		await (await harness.session()).prompt('Look up values.');

		const start = events.find((event) => event.type === 'tool_start' && event.toolName === 'lookup');
		expect(start).toBeDefined();
		expect(start).not.toHaveProperty('args');
		expect(events.filter((event) => event.type === 'tool' && event.toolName === 'lookup')).toEqual([
			expect.objectContaining({ isError: true }),
		]);
	});

	it('rejects legacy markers on an inline runtime tool', async () => {
		const provider = createProvider();

		await expect(
			createContext(provider).initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					tools: [
						{
							name: 'lookup',
							description: 'Look up a value.',
							run: async () => 'ok',
							parameters: undefined,
						} as never,
					],
				})),
			),
		).rejects.toThrow(ToolLegacyDefinitionError);
	});

	it('renders string, object, null, and no-output undefined as JSON for the model', async () => {
		const provider = createProvider();
		const modelResults: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('render_string', {}), { stopReason: 'toolUse' }),
			(context) => {
				modelResults.push(context.messages.at(-1));
				return fauxAssistantMessage(fauxToolCall('render_object', {}), { stopReason: 'toolUse' });
			},
			(context) => {
				modelResults.push(context.messages.at(-1));
				return fauxAssistantMessage(fauxToolCall('render_null', {}), { stopReason: 'toolUse' });
			},
			(context) => {
				modelResults.push(context.messages.at(-1));
				return fauxAssistantMessage(fauxToolCall('render_undefined', {}), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				modelResults.push(context.messages.at(-1));
				return fauxAssistantMessage('Done.');
			},
		]);
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'render_string',
						description: 'Render a string.',
						run: async () => 'hello',
					}),
					defineTool({
						name: 'render_object',
						description: 'Render an object.',
						run: async () => ({ count: 2 }),
					}),
					defineTool({
						name: 'render_null',
						description: 'Render null.',
						run: async () => null,
					}),
					defineTool({
						name: 'render_undefined',
						description: 'Render no output.',
						run: async () => undefined,
					}),
				],
			})),
		);

		await (await harness.session()).prompt('Render values.');

		expect(modelResults).toEqual([
			expect.objectContaining({ content: [{ type: 'text', text: '"hello"' }] }),
			expect.objectContaining({ content: [{ type: 'text', text: '{"count":2}' }] }),
			expect.objectContaining({ content: [{ type: 'text', text: 'null' }] }),
			expect.objectContaining({ content: [{ type: 'text', text: 'null' }] }),
		]);
	});

	it('provides complete execution identity to agent, model, and tool interceptors', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const intercepted: Array<{ operation: FlueExecutionOperation; context: FlueExecutionContext }> = [];
		const dispose = instrument({
			observe() {},
			async interceptor(operation, context, next) {
				intercepted.push({ operation, context });
				return next();
			},
			dispose() {},
		});
		try {
			const harness = await createContext(provider).initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					tools: [defineTool({ name: 'lookup', description: 'Look up a value.', run: async () => ({ found: true }) })],
				})),
			);
			const session = await harness.session();

			await session.prompt('Look up the value.');

			const agent = intercepted.find(({ operation }) => operation.type === 'agent');
			const model = intercepted.find(({ operation }) => operation.type === 'model');
			const tool = intercepted.find(({ operation }) => operation.type === 'tool');
			expect(agent).toMatchObject({ context: { instanceId: 'tool-test-instance', harness: 'default', conversationId: session.conversationId, session: 'default', operationId: expect.any(String) } });
			expect(model).toMatchObject({ context: { instanceId: 'tool-test-instance', harness: 'default', conversationId: session.conversationId, session: 'default', operationId: agent?.context.operationId, turnId: expect.any(String) } });
			expect(tool).toMatchObject({ operation: { toolName: 'lookup' }, context: { instanceId: 'tool-test-instance', harness: 'default', conversationId: session.conversationId, session: 'default', operationId: agent?.context.operationId, turnId: expect.any(String) } });
		} finally {
			await dispose();
		}
	});

	it('publishes the effective output separately from the product tool result', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const events: FlueEvent[] = [];
		const observations: FlueObservation[] = [];
		const context = createContext(provider);
		context.subscribeEvent((event) => {
			events.push(event);
		});
		const stopObserving = observe((event, observedContext) => {
			if (observedContext === context) observations.push(event);
		});
		try {
			const harness = await context.initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					tools: [
						defineTool({
							name: 'lookup',
							description: 'Look up a value.',
							run: async () => ({ found: true }),
						}),
					],
				})),
			);

			await (await harness.session()).prompt('Look up the value.');

			const productEvent = events.find(
				(event) => event.type === 'tool' && event.toolName === 'lookup',
			);
			expect(productEvent).toMatchObject({
				result: { details: { customTool: 'lookup', output: { found: true } } },
			});
			expect(productEvent).not.toHaveProperty('effectiveResult');
			expect(
				observations.find((event) => event.type === 'tool' && event.toolName === 'lookup'),
			).toMatchObject({ effectiveResult: { found: true } });
		} finally {
			stopObserving();
		}
	});

	it('caches one frozen provider schema across model turns', async () => {
		const provider = createProvider();
		const schemas: unknown[] = [];
		provider.setResponses([
			(context) => {
				schemas.push(context.tools?.find((tool) => tool.name === 'lookup')?.parameters);
				return fauxAssistantMessage('First.');
			},
			(context) => {
				schemas.push(context.tools?.find((tool) => tool.name === 'lookup')?.parameters);
				return fauxAssistantMessage('Second.');
			},
		]);
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						input: v.object({ query: v.string() }),
						run: async () => 'ok',
					}),
				],
			})),
		);
		const session = await harness.session();

		await session.prompt('First prompt.');
		await session.prompt('Second prompt.');

		expect(schemas[0]).toEqual({
			type: 'object',
			properties: { query: { type: 'string' } },
			required: ['query'],
		});
		expect(schemas[1]).toBe(schemas[0]);
		expect(Object.isFrozen(schemas[0])).toBe(true);
	});

	it('forwards parsed input and the operation abort signal to run', async () => {
		const provider = createProvider();
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { count: 2 }), { stopReason: 'toolUse' }),
		]);
		let receivedInput: unknown;
		let receivedSignal: AbortSignal | undefined;
		let markStarted: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const lookup = defineTool({
			name: 'lookup',
			description: 'Look up a count.',
			input: v.object({ count: v.number() }),
			async run({ input, signal }) {
				receivedInput = input;
				receivedSignal = signal;
				markStarted();
				await new Promise<void>((resolve) => signal?.addEventListener('abort', () => resolve()));
				return 'interrupted';
			},
		});
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [lookup],
			})),
		);
		const session = await harness.session();

		const operation = session.prompt('Look up two values.');
		await started;
		operation.abort('stop');

		await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
		expect(receivedInput).toEqual({ count: 2 });
		expect(receivedSignal?.aborted).toBe(true);
	});

	it('rejects a custom tool when its name collides with a built-in tool', async () => {
		const session = await createSession(createProvider());

		await expect(
			session.prompt('Use the tool.', {
				tools: [
					defineTool({
						name: 'bash',
						description: 'Run bash.',
						run: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow(ToolNameConflictError);
	});

	it('rejects duplicate custom tool names when active tools are assembled', async () => {
		const provider = createProvider();
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up a value.',
						run: async () => 'ok',
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
						run: async () => 'ok',
					}),
				],
			}),
		).rejects.toThrow(ToolNameConflictError);
	});
});
