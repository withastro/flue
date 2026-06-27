import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	ActionOutputSerializationError,
	ActionOutputValidationError,
	defineAction,
	defineAgent,
	defineTool,
	ToolNameConflictError,
} from '../src/index.ts';
import { createFlueContext } from '../src/internal.ts';
import type { SessionEnv } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `action-execution-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

function createAgentTool(name: string) {
	return {
		name,
		label: name,
		description: `Run ${name}.`,
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		async execute() {
			return { content: [{ type: 'text' as const, text: 'ok' }], details: {} };
		},
	};
}

function createContext(
	provider: FauxProviderRegistration,
	env: SessionEnv = createNoopSessionEnv(),
) {
	return createFlueContext({
		id: 'action-instance',
		env: {},
		agentConfig: { resolveModel: () => provider.getModel() },
		createDefaultEnv: async () => env,
	});
}

describe('model-called Actions', () => {
	it('exposes the Action input as model tool parameters', async () => {
		const provider = createProvider();
		let parameters: unknown;
		const action = defineAction({
			name: 'inspect_repository',
			description: 'Inspect a repository.',
			input: v.object({ repository: v.string(), depth: v.optional(v.number()) }),
			async run() {
				return undefined;
			},
		});
		provider.setResponses([
			(context) => {
				parameters = context.tools?.find((tool) => tool.name === action.name)?.parameters;
				return fauxAssistantMessage('Done.');
			},
		]);
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [action],
			})),
		);

		await (await harness.session()).prompt('Inspect the repository.');

		expect(parameters).toMatchObject({
			type: 'object',
			properties: {
				repository: { type: 'string' },
				depth: { type: 'number' },
			},
			required: ['repository'],
		});
	});

	it('returns validated JSON-cloned output while isolating and retaining Action sessions', async () => {
		const provider = createProvider();
		let modelResult: unknown;
		const source = { status: 'reviewed' };
		const review = defineAction({
			name: 'review_repository',
			description: 'Review a repository.',
			input: v.object({ repository: v.string() }),
			output: v.object({ status: v.string() }),
			async run({ harness, input }) {
				expect(input).toEqual({ repository: 'withastro/flue' });
				const defaultSession = await harness.session();
				const namedSession = await harness.session('notes');
				expect(defaultSession.name).toBe('default');
				expect(namedSession.name).toBe('notes');
				return source;
			},
		});
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall(
					'review_repository',
					{ repository: 'withastro/flue' },
					{ id: 'call-action-1' },
				),
				{ stopReason: 'toolUse' },
			),
			(context) => {
				modelResult = context.messages.at(-1);
				return fauxAssistantMessage('Reviewed.');
			},
		]);
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [review],
			})),
		);
		const parent = await harness.session();

		await parent.prompt('Review the repository.');
		source.status = 'mutated';

		expect(modelResult).toMatchObject({
			role: 'toolResult',
			toolCallId: 'call-action-1',
			toolName: 'review_repository',
			content: [{ type: 'text', text: '{"status":"reviewed"}' }],
			isError: false,
		});
	});

	it('shares the parent filesystem without creating another sandbox', async () => {
		const provider = createProvider();
		const writeFile = vi.fn(async () => {});
		const sharedEnv = createNoopSessionEnv({ writeFile });
		const createSessionEnv = vi.fn(async () => sharedEnv);
		const action = defineAction({
			name: 'write_report',
			description: 'Write a report.',
			async run({ harness }) {
				await harness.fs.writeFile('report.txt', 'complete');
				return { done: true };
			},
		});
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('write_report', {}), { stopReason: 'toolUse' }),
			fauxAssistantMessage('Done.'),
		]);
		const harness = await createContext(provider).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				sandbox: { createSessionEnv },
				actions: [action],
			})),
		);

		await (await harness.session()).prompt('Write the report.');

		expect(createSessionEnv).toHaveBeenCalledOnce();
		expect(writeFile).toHaveBeenCalledWith('report.txt', 'complete');
	});

	it('inherits selected-profile capabilities and config through Task to Action to Task', async () => {
		const provider = createProvider();
		const exec = vi.fn(async () => ({ stdout: 'ok', stderr: '', exitCode: 0 }));
		let actionToolNames: string[] = [];
		let nestedTaskToolNames: string[] = [];
		const profileAction = defineAction({
			name: 'inspect_task_scope',
			description: 'Inspect the selected task scope.',
			async run({ harness }) {
				await harness.shell('pwd');
				const session = await harness.session();
				await session.prompt('List inherited capabilities.');
				await session.task('Inspect inherited task capabilities.');
				return undefined;
			},
		});
		provider.setResponses([
			fauxAssistantMessage(
				fauxToolCall('task', {
					prompt: 'Inspect the task scope.',
					agent: 'reviewer',
					cwd: 'packages/runtime',
				}),
				{ stopReason: 'toolUse' },
			),
			fauxAssistantMessage(fauxToolCall('inspect_task_scope', {}), { stopReason: 'toolUse' }),
			(context) => {
				actionToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('Capabilities inherited.');
			},
			(context) => {
				nestedTaskToolNames = (context.tools ?? []).map((tool) => tool.name);
				return fauxAssistantMessage('Nested task complete.');
			},
			fauxAssistantMessage('Task complete.'),
			fauxAssistantMessage('Root complete.'),
		]);
		const selectedTool = defineTool({
			name: 'selected_tool',
			description: 'Selected profile tool.',
			input: v.object({}),
			run: async () => 'selected',
		});
		const harness = await createContext(
			provider,
			createNoopSessionEnv({ exec }),
		).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				subagents: [
					{
						name: 'reviewer',
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
						tools: [selectedTool],
						actions: [profileAction],
					},
				],
			})),
		);

		await (await harness.session()).prompt('Delegate inspection.');

		expect(exec).toHaveBeenCalledWith(
			'pwd',
			expect.objectContaining({ cwd: '/repo/packages/runtime' }),
		);
		expect(actionToolNames).toContain('selected_tool');
		expect(actionToolNames).toContain('inspect_task_scope');
		expect(nestedTaskToolNames).toContain('selected_tool');
		expect(nestedTaskToolNames).toContain('inspect_task_scope');
	});

	it('cancels direct harness shell calls and waits for cleanup before an Action settles', async () => {
		const provider = createProvider();
		let startedResolve: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		let settled = false;
		let receivedSignal: AbortSignal | undefined;
		const action = defineAction({
			name: 'run_direct_shell',
			description: 'Run a direct harness shell call.',
			async run({ harness }) {
				void harness.shell('wait').then(
					() => {
						settled = true;
					},
					() => {
						settled = true;
					},
				);
				await started;
				throw new Error('finish Action');
			},
		});
		const env = createNoopSessionEnv({
			exec: async (_command, options) => {
				receivedSignal = options?.signal;
				startedResolve();
				if (!options?.signal?.aborted) {
					await new Promise<void>((resolve) =>
						options?.signal?.addEventListener('abort', () => resolve()),
					);
				}
				throw new DOMException('aborted', 'AbortError');
			},
		});
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('run_direct_shell', {}), { stopReason: 'toolUse' }),
			(_context) => {
				expect(settled).toBe(true);
				return fauxAssistantMessage('Handled.');
			},
		]);
		const harness = await createContext(provider, env).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [action],
			})),
		);

		await (await harness.session()).prompt('Run shell.');

		expect(receivedSignal?.aborted).toBe(true);
		expect(settled).toBe(true);
	});

	it('retains child sessions and cancels every active Action operation when the parent is aborted', async () => {
		const provider = createProvider();
		let startedResolve: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			startedResolve = resolve;
		});
		const signals: AbortSignal[] = [];
		const action = defineAction({
			name: 'wait_for_children',
			description: 'Wait for child operations.',
			async run({ harness }) {
				const first = await harness.session();
				const second = await harness.session('second');
				const calls = [first.shell('first'), second.shell('second')];
				await Promise.all(calls);
				return undefined;
			},
		});
		const env = createNoopSessionEnv({
			exec: async (_command, options) => {
				if (options?.signal) signals.push(options.signal);
				if (signals.length === 2) startedResolve();
				if (!options?.signal?.aborted) {
					await new Promise<void>((resolve) =>
						options?.signal?.addEventListener('abort', () => resolve()),
					);
				}
				throw new DOMException('aborted', 'AbortError');
			},
		});
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('wait_for_children', {}), { stopReason: 'toolUse' }),
		]);
		const harness = await createContext(provider, env).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [action],
			})),
		);
		const parent = await harness.session();

		const operation = parent.prompt('Wait.');
		await Promise.race([
			started,
			new Promise<never>((_, reject) =>
				setTimeout(() => reject(new Error(`started ${signals.length} Action operations`)), 1_000),
			),
		]);
		operation.abort('stop');

		await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
		expect(signals).toHaveLength(2);
		expect(signals.every((signal) => signal.aborted)).toBe(true);
	});
});

describe('Action model tools', () => {
	it('rejects one final namespace collision across custom Action and result tools', async () => {
		const provider = createProvider();
		const lookup = defineAction({
			name: 'lookup',
			description: 'Look up a value.',
			async run() {
				return undefined;
			},
		});
		const harness = await createContext(
			provider,
		).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [lookup],
				tools: [
					defineTool({
						name: 'lookup',
						description: 'Look up another value.',
						input: v.object({}),
						run: async () => 'ok',
					}),
				],
			})),
		);

		await expect(harness.session()).rejects.toThrow(ToolNameConflictError);
	});

	it('rejects adapter framework-reserved names regardless of active result or skill tools', async () => {
		for (const name of ['task', 'activate_skill', 'read_skill_resource', 'finish', 'give_up']) {
			const provider = createProvider();
			const harness = await createContext(
				provider,
				).initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					sandbox: {
						createSessionEnv: async () => createNoopSessionEnv(),
						tools: () => [createAgentTool(name)],
					},
				})),
			);

			await expect(harness.session()).rejects.toMatchObject({
				type: 'tool_name_conflict',
				message: expect.stringContaining(name),
			});
		}

		for (const name of ['task', 'activate_skill', 'read_skill_resource', 'finish', 'give_up']) {
			const provider = createProvider();
			const harness = await createContext(
				provider,
				).initializeRootHarness(
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					skills: [{ name: 'review', description: 'Review inputs.' }],
					sandbox: {
						createSessionEnv: async () => createNoopSessionEnv(),
						tools: () => [createAgentTool(name)],
					},
				})),
			);
			const session = await harness.session().catch((error) => error);
			if (session instanceof Error) {
				expect(session).toMatchObject({ type: 'tool_name_conflict' });
				continue;
			}
			await expect(
				session.prompt('Return a result.', { result: v.object({ ok: v.boolean() }) }),
			).rejects.toMatchObject({ type: 'tool_name_conflict' });
		}
	});

	it('strictly snapshots valid Action output before returning it to the model', async () => {
		const provider = createProvider();
		const source = { nested: { values: [1, true, null, 'ok'] } };
		let modelResult: unknown;
		const action = defineAction({
			name: 'valid_snapshot',
			description: 'Return valid JSON output.',
			async run() {
				return source;
			},
		});
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('valid_snapshot', {}), { stopReason: 'toolUse' }),
			(context) => {
				modelResult = context.messages.at(-1);
				return fauxAssistantMessage('Done.');
			},
		]);
		const harness = await createContext(
			provider,
		).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [action],
			})),
		);

		await (await harness.session()).prompt('Snapshot output.');
		source.nested.values[0] = 9;

		expect(modelResult).toMatchObject({
			role: 'toolResult',
			content: [{ type: 'text', text: '{"nested":{"values":[1,true,null,"ok"]}}' }],
		});
	});

	it('rejects Action outputs that JSON.stringify would silently coerce or discard', async () => {
		const provider = createProvider();
		const nonFinite = defineAction({
			name: 'non_finite_output',
			description: 'Return a non-finite number.',
			async run() {
				return { count: Number.NaN };
			},
		});
		const nestedUndefined = defineAction({
			name: 'undefined_output',
			description: 'Return nested undefined.',
			async run() {
				return { result: undefined } as never;
			},
		});
		const dateOutput = defineAction({
			name: 'date_output',
			description: 'Return a Date.',
			async run() {
				return { createdAt: new Date('2026-06-19T00:00:00.000Z') } as never;
			},
		});
		const toolErrors: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('non_finite_output', {}), { stopReason: 'toolUse' }),
			(context) => {
				toolErrors.push(context.messages.at(-1));
				return fauxAssistantMessage(fauxToolCall('undefined_output', {}), {
					stopReason: 'toolUse',
				});
			},
			(context) => {
				toolErrors.push(context.messages.at(-1));
				return fauxAssistantMessage(fauxToolCall('date_output', {}), { stopReason: 'toolUse' });
			},
			(context) => {
				toolErrors.push(context.messages.at(-1));
				return fauxAssistantMessage('Rejected unsafe outputs.');
			},
		]);
		const harness = await createContext(
			provider,
		).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [nonFinite, nestedUndefined, dateOutput],
			})),
		);

		await (await harness.session()).prompt('Check outputs.');

		expect(toolErrors).toHaveLength(3);
		for (const error of toolErrors) {
			expect(error).toMatchObject({
				role: 'toolResult',
				isError: true,
				content: [
					expect.objectContaining({ text: expect.stringContaining('not JSON-serializable') }),
				],
			});
		}
	});

	it('rejects invalid and non-serializable Action output before returning a tool result', async () => {
		const provider = createProvider();
		const invalid = defineAction({
			name: 'invalid_output',
			description: 'Return invalid output.',
			output: v.object({ ok: v.boolean() }),
			async run() {
				return { ok: 'no' } as never;
			},
		});
		const cyclic = defineAction({
			name: 'cyclic_output',
			description: 'Return cyclic output.',
			async run() {
				const value: Record<string, unknown> = {};
				value.self = value;
				return value as never;
			},
		});
		const toolErrors: unknown[] = [];
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall('invalid_output', {}), { stopReason: 'toolUse' }),
			(context) => {
				toolErrors.push(context.messages.at(-1));
				return fauxAssistantMessage('Invalid handled.');
			},
			fauxAssistantMessage(fauxToolCall('cyclic_output', {}), { stopReason: 'toolUse' }),
			(context) => {
				toolErrors.push(context.messages.at(-1));
				return fauxAssistantMessage('Cyclic handled.');
			},
		]);
		const harness = await createContext(
			provider,
		).initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				actions: [invalid, cyclic],
			})),
		);
		const session = await harness.session();

		await expect(session.prompt('Invalid.')).resolves.toBeDefined();
		await expect(session.prompt('Cyclic.')).resolves.toBeDefined();
		expect(toolErrors).toEqual([
			expect.objectContaining({
				role: 'toolResult',
				toolName: 'invalid_output',
				isError: true,
				content: [expect.objectContaining({ text: expect.stringContaining('does not match') })],
			}),
			expect.objectContaining({
				role: 'toolResult',
				toolName: 'cyclic_output',
				isError: true,
				content: [
					expect.objectContaining({ text: expect.stringContaining('not JSON-serializable') }),
				],
			}),
		]);
		expect(ActionOutputValidationError).toBeDefined();
		expect(ActionOutputSerializationError).toBeDefined();
	});
});
