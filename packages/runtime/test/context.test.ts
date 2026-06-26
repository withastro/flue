import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vitest';
import { defineAgent } from '../src/index.ts';
import type { FlueContextConfig } from '../src/internal.ts';
import { createFlueContext } from '../src/internal.ts';
import type { FlueEvent, SessionEnv } from '../src/types.ts';

const providers: FauxProviderRegistration[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
});

function createProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({ provider: `context-test-${crypto.randomUUID()}` });
	providers.push(provider);
	return provider;
}

function createEnv({
	cwd = '/repo',
	files = {},
}: { cwd?: string; files?: Record<string, string> } = {}): SessionEnv {
	const normalize = (path: string) => {
		const segments: string[] = [];
		for (const segment of path.split('/')) {
			if (!segment || segment === '.') continue;
			if (segment === '..') segments.pop();
			else segments.push(segment);
		}
		return `/${segments.join('/')}`;
	};
	const resolvePath = (path: string) => normalize(path.startsWith('/') ? path : `${cwd}/${path}`);

	return {
		cwd,
		resolvePath,
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async (path) => {
			const content = files[resolvePath(path)];
			if (content === undefined) throw new Error(`missing file: ${path}`);
			return content;
		},
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async (path) => {
			const resolved = resolvePath(path);
			return {
				isFile: Object.hasOwn(files, resolved),
				isDirectory: Object.keys(files).some((file) => file.startsWith(`${resolved}/`)),
				isSymbolicLink: false,
				size: 0,
				mtime: new Date(0),
			};
		},
		readdir: async (path) => {
			const resolved = resolvePath(path);
			const entries = new Set<string>();
			for (const file of Object.keys(files)) {
				if (!file.startsWith(`${resolved}/`)) continue;
				const entry = file.slice(resolved.length + 1).split('/')[0];
				if (entry) entries.add(entry);
			}
			return [...entries];
		},
		exists: async (path) => {
			const resolved = resolvePath(path);
			return (
				Object.hasOwn(files, resolved) ||
				Object.keys(files).some((file) => file.startsWith(`${resolved}/`))
			);
		},
		mkdir: async () => {},
		rm: async () => {},
	};
}

function createContext(overrides: Partial<FlueContextConfig> = {}) {
	return createFlueContext({
		id: 'context-instance',
		env: {},
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => createEnv(),
		...overrides,
	});
}

describe('FlueContext', () => {
	it('exposes id env and request when the runtime creates a context', () => {
		const env = { API_KEY: 'test-key' };
		const req = new Request('https://example.com/agents/reviewer', {
			headers: { authorization: 'Bearer test-token' },
		});
		const ctx = createContext({ id: 'agent-reviewer', env, req });

		expect(ctx.id).toBe('agent-reviewer');
		expect(ctx.env).toBe(env);
		expect(ctx.req).toBe(req);
	});

	it('decorates workflow events with run identity when a context has a run id', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'workflow-instance', runId: 'run-123' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});

		ctx.emitEvent({ type: 'idle' });

		expect(events).toEqual([
			{
				type: 'idle',
				runId: 'run-123',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
		]);
	});

	it('decorates agent events with instance identity when a context has no run id', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-instance' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});

		ctx.emitEvent({ type: 'idle' });

		expect(events).toEqual([
			{
				type: 'idle',
				instanceId: 'agent-instance',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
		]);
	});

	it('decorates agent events with dispatch identity when a context has a dispatch id', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-instance', dispatchId: 'dispatch-123' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});

		ctx.emitEvent({ type: 'idle' });

		expect(events).toEqual([
			{
				type: 'idle',
				instanceId: 'agent-instance',
				dispatchId: 'dispatch-123',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
		]);
	});

	it('assigns increasing event indexes when a context emits multiple events', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-indexed' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});

		ctx.emitEvent({ type: 'idle' });
		ctx.emitEvent({ type: 'idle' });
		ctx.emitEvent({ type: 'idle' });

		expect(events).toEqual([
			{
				type: 'idle',
				instanceId: 'agent-indexed',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
			{
				type: 'idle',
				instanceId: 'agent-indexed',
				v: 3,
				eventIndex: 1,
				timestamp: expect.any(String),
			},
			{
				type: 'idle',
				instanceId: 'agent-indexed',
				v: 3,
				eventIndex: 2,
				timestamp: expect.any(String),
			},
		]);
	});

	it('emits structured log events when application code calls context log methods', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-logger' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});

		ctx.log.info('Started review.', { phase: 'start' });
		ctx.log.warn('Waiting for input.', { phase: 'wait' });
		ctx.log.error('Review failed.', { phase: 'stop' });

		expect(events).toEqual([
			{
				type: 'log',
				level: 'info',
				message: 'Started review.',
				attributes: { phase: 'start' },
				instanceId: 'agent-logger',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
			{
				type: 'log',
				level: 'warn',
				message: 'Waiting for input.',
				attributes: { phase: 'wait' },
				instanceId: 'agent-logger',
				v: 3,
				eventIndex: 1,
				timestamp: expect.any(String),
			},
			{
				type: 'log',
				level: 'error',
				message: 'Review failed.',
				attributes: { phase: 'stop' },
				instanceId: 'agent-logger',
				v: 3,
				eventIndex: 2,
				timestamp: expect.any(String),
			},
		]);
	});

	it('emits a detached data event when application code calls emitData', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-data' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const data = { status: 'running', nested: { attempt: 1 } };

		ctx.emitData('draft.status', data, { id: 'draft-1' });
		data.nested.attempt = 2;

		expect(events).toEqual([
			{
				type: 'data',
				name: 'draft.status',
				id: 'draft-1',
				data: { status: 'running', nested: { attempt: 1 } },
				instanceId: 'agent-data',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
		]);
	});

	it('throws a structured error before emitting when data is invalid', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-data' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});

		expect(() => ctx.emitData('invalid name', {})).toThrowError(
			expect.objectContaining({
				type: 'data_part_validation',
				meta: { name: 'invalid name', field: 'name' },
			}),
		);
		expect(() => ctx.emitData(Symbol('draft') as never, {})).toThrowError(
			expect.objectContaining({
				type: 'data_part_validation',
				meta: expect.objectContaining({ field: 'name' }),
			}),
		);
		expect(() => ctx.emitData('draft', {}, { id: {} as never })).toThrowError(
			expect.objectContaining({
				type: 'data_part_validation',
				meta: { name: 'draft', field: 'id' },
			}),
		);
		expect(() => ctx.emitData('draft', { missing: undefined })).toThrowError(
			expect.objectContaining({
				type: 'data_part_validation',
				meta: { name: 'draft', field: 'data' },
			}),
		);
		expect(events).toEqual([]);
	});

	it('serializes attributes.error when application code logs an Error instance', () => {
		const events: FlueEvent[] = [];
		const ctx = createContext({ id: 'agent-error-logger' });
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const error = new TypeError('invalid review input');

		ctx.log.error('Review failed.', { error, attempt: 2 });

		expect(events).toEqual([
			{
				type: 'log',
				level: 'error',
				message: 'Review failed.',
				attributes: {
					error: {
						name: 'TypeError',
						message: 'invalid review input',
						stack: error.stack,
					},
					attempt: 2,
				},
				instanceId: 'agent-error-logger',
				v: 3,
				eventIndex: 0,
				timestamp: expect.any(String),
			},
		]);
	});

	it('allows root harness initialization to retry after an earlier attempt fails', async () => {
		let attempt = 0;
		const ctx = createContext();
		const agent = defineAgent(() => ({
			model: false,
			sandbox: {
				createSessionEnv: async () => {
					attempt += 1;
					if (attempt === 1) throw new Error('temporary sandbox failure');
					return createEnv();
				},
			},
		}));

		await expect(ctx.initializeRootHarness(agent)).rejects.toThrow('temporary sandbox failure');
		await expect(ctx.initializeRootHarness(agent)).resolves.toMatchObject({
			name: 'default',
		});
	});
});

describe('session context discovery', () => {
	it('includes agent instructions and discovered AGENTS.md content when the initial model request begins', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Reviewed.')]);
		const events: FlueEvent[] = [];
		const ctx = createContext({
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () =>
				createEnv({ files: { '/repo/AGENTS.md': 'Workspace review guidance.' } }),
		});
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				instructions: 'Agent-specific review instructions.',
			})),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');

		const request = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
				event.type === 'turn_request',
		);
		const terminal = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn' }> => event.type === 'turn',
		);
		expect(request).toMatchObject({
			request: {
				providerId: provider.getModel().provider,
				providerName: provider.getModel().provider,
				requestedModel: provider.getModel().id,
				api: provider.getModel().api,
				input: { messages: expect.any(Array) },
			},
		});
		expect(request).not.toHaveProperty('model');
		expect(request).not.toHaveProperty('input');
		expect(terminal).toMatchObject({
			request: {
				providerId: provider.getModel().provider,
				providerName: provider.getModel().provider,
				requestedModel: provider.getModel().id,
			},
			response: { output: expect.any(Object), usage: expect.any(Object) },
		});
		expect(terminal).not.toHaveProperty('output');
		expect(terminal).not.toHaveProperty('usage');
		const systemPrompt = request?.request.input.systemPrompt ?? '';
		expect(systemPrompt).toContain('Agent-specific review instructions.');
		expect(systemPrompt).toContain('Workspace review guidance.');
		expect(systemPrompt.indexOf('Agent-specific review instructions.')).toBeLessThan(
			systemPrompt.indexOf('Workspace review guidance.'),
		);
	});

	it('includes CLAUDE.md content when it exists beside AGENTS.md', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Reviewed.')]);
		const events: FlueEvent[] = [];
		const ctx = createContext({
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () =>
				createEnv({
					files: {
						'/repo/AGENTS.md': 'Workspace review guidance.',
						'/repo/CLAUDE.md': 'Claude-specific workspace guidance.',
					},
				}),
		});
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
			})),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');

		const request = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
				event.type === 'turn_request',
		);
		const systemPrompt = request?.request.input.systemPrompt ?? '';
		expect(systemPrompt).toContain('Workspace review guidance.');
		expect(systemPrompt).toContain('Claude-specific workspace guidance.');
		expect(systemPrompt.indexOf('Workspace review guidance.')).toBeLessThan(
			systemPrompt.indexOf('Claude-specific workspace guidance.'),
		);
	});

	it('discovers context from the agent-definition cwd when a relative cwd is configured', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Reviewed.')]);
		const events: FlueEvent[] = [];
		const ctx = createContext({
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () =>
				createEnv({
					cwd: '/repo',
					files: {
						'/repo/AGENTS.md': 'Root workspace guidance.',
						'/repo/workspace/AGENTS.md': 'Nested workspace guidance.',
					},
				}),
		});
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				cwd: 'workspace',
			})),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');

		const request = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
				event.type === 'turn_request',
		);
		const systemPrompt = request?.request.input.systemPrompt ?? '';
		expect(systemPrompt).toContain('Nested workspace guidance.');
		expect(systemPrompt).toContain('Working directory: /repo/workspace');
		expect(systemPrompt).not.toContain('Root workspace guidance.');
	});

	it('scopes a custom sandbox cwd once when a relative agent-definition cwd is configured', async () => {
		const provider = createProvider();
		provider.setResponses([fauxAssistantMessage('Reviewed.')]);
		const events: FlueEvent[] = [];
		const factoryOptions: { id: string }[] = [];
		const ctx = createContext({
			agentConfig: {
				resolveModel: () => provider.getModel(),
			},
		});
		ctx.setEventCallback((event) => {
			events.push(event);
		});
		const harness = await ctx.initializeRootHarness(
			defineAgent(() => ({
				model: `${provider.getModel().provider}/${provider.getModel().id}`,
				cwd: 'workspace',
				sandbox: {
					createSessionEnv: async (options) => {
						factoryOptions.push(options);
						return createEnv({
							cwd: '/sandbox',
							files: {
								'/sandbox/AGENTS.md': 'Sandbox root guidance.',
								'/sandbox/workspace/AGENTS.md': 'Sandbox workspace guidance.',
							},
						});
					},
				},
			})),
		);
		const session = await harness.session();

		await session.prompt('Review this workspace.');

		const request = events.find(
			(event): event is Extract<FlueEvent, { type: 'turn_request' }> =>
				event.type === 'turn_request',
		);
		const systemPrompt = request?.request.input.systemPrompt ?? '';
		expect(factoryOptions).toEqual([{ id: 'context-instance' }]);
		expect(systemPrompt).toContain('Sandbox workspace guidance.');
		expect(systemPrompt).toContain('Working directory: /sandbox/workspace');
		expect(systemPrompt).not.toContain('Sandbox root guidance.');
	});
});
