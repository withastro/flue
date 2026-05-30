import { fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall, registerFauxProvider, Type } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createAgent } from '../src/agent-definition.ts';
import { observe } from '../src/app.ts';
import { createFlueContext, type DispatchInput, InMemorySessionStore } from '../src/internal.ts';
import type { DirectAgentToolDeclaration, FlueEvent, FlueSession, SessionEnv } from '../src/types.ts';

function createEnv(): SessionEnv {
	return {
		cwd: '/',
		resolvePath: (path) => (path.startsWith('/') ? path : `/${path}`),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: false, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date(0) }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
	};
}

describe('observe model-turn telemetry', () => {
	it('isolates observer failures and supports unsubscribing', () => {
		const seen: string[] = [];
		const stopThrowing = observe(() => {
			throw new Error('observer failure');
		});
		const stopRecording = observe((event, ctx) => {
			if (ctx.id === 'observer-lifecycle') seen.push(event.type);
		});
		const ctx = createFlueContext({
			id: 'observer-lifecycle',
			runId: undefined,
			payload: {},
			env: {},
			agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
			createDefaultEnv: async () => createEnv(),
			defaultStore: new InMemorySessionStore(),
		});
		const originalError = console.error;
		console.error = () => {};
		try {
			ctx.emitEvent({ type: 'idle' });
			stopRecording();
			ctx.emitEvent({ type: 'idle' });
			expect(seen).toEqual(['idle']);
		} finally {
			console.error = originalError;
			stopThrowing();
			stopRecording();
		}
	});

	it('exposes exact model request input and terminal output through public events', async () => {
		const provider = `faux-${crypto.randomUUID()}`;
		const modelId = 'observer';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({
			provider,
			models: [{ id: modelId, reasoning: true }],
		});
		registration.setResponses([
			fauxAssistantMessage([fauxThinking('reasoned'), fauxText('captured')]),
		]);
		const events: FlueEvent[] = [];
		const stopObserving = observe((event, ctx) => {
			if (ctx.id === 'observer-instance') events.push(event);
		});

		try {
			const ctx = createFlueContext({
				id: 'observer-instance',
				runId: undefined,
				payload: {},
				env: {},
				agentConfig: {
					systemPrompt: '',
					skills: {},
					model: undefined,
					resolveModel: (model) => model === modelSpecifier ? registration.getModel(modelId) : undefined,
				},
				createDefaultEnv: async () => createEnv(),
				defaultStore: new InMemorySessionStore(),
			});
			const agent = createAgent(() => ({
				model: modelSpecifier,
				thinkingLevel: 'high',
				tools: [{
					name: 'lookup',
					description: 'Look up a record.',
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => 'not used',
				}],
			}));
			const harness = await ctx.init(agent);
			const session = await harness.session();

			const response = await session.prompt('What reaches the model?');

			expect(response.model).toEqual({ provider, id: modelId });
			const turnStart = events.find((event): event is Extract<FlueEvent, { type: 'turn_start' }> => event.type === 'turn_start');
			const turnRequest = events.find((event): event is Extract<FlueEvent, { type: 'turn_request' }> => event.type === 'turn_request');
			const turn = events.find((event): event is Extract<FlueEvent, { type: 'turn' }> => event.type === 'turn');
			expect(turnStart?.turnId).toMatch(/^turn_/);
			expect(turnRequest?.turnId).toBe(turnStart?.turnId);
			expect(turn?.turnId).toBe(turnStart?.turnId);
			expect(turnRequest).toMatchObject({
				purpose: 'agent',
				instanceId: 'observer-instance',
				session: 'default',
				harness: 'default',
				model: modelId,
				provider,
				reasoning: 'high',
			});
			expect(turnRequest?.operationId).toMatch(/^op_/);
			expect(turnRequest?.input.messages[0]).toMatchObject({
				role: 'user',
				content: [{ type: 'text', text: 'What reaches the model?' }],
			});
			expect(turnRequest?.input.tools?.find((tool) => tool.name === 'lookup')).toMatchObject({
				name: 'lookup',
				description: 'Look up a record.',
			});
			expect(turn).toMatchObject({ provider, model: modelId, output: { role: 'assistant' } });
			expect(turn?.output?.content).toEqual([
				{ type: 'thinking', thinking: 'reasoned', thinkingSignature: undefined, redacted: undefined },
				{ type: 'text', text: 'captured', textSignature: undefined },
			]);
			expect(events.findIndex((event) => event.type === 'turn_start')).toBeLessThan(events.findIndex((event) => event.type === 'turn_request'));
			expect(events.findIndex((event) => event.type === 'turn_request')).toBeLessThan(events.findIndex((event) => event.type === 'turn'));
		} finally {
			stopObserving();
			registration.unregister();
		}
	});

	it('emits normalized tool telemetry for harness shell without session operations', async () => {
		const events: FlueEvent[] = [];
		const ctx = createFlueContext({
			id: 'harness-shell-instance',
			runId: undefined,
			payload: {},
			env: {},
			agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: () => undefined },
			createDefaultEnv: async () => ({
				...createEnv(),
				exec: async () => ({ stdout: 'prepared', stderr: '', exitCode: 0 }),
			}),
			defaultStore: new InMemorySessionStore(),
		});
		ctx.subscribeEvent((event) => { events.push(event); });
		const harness = await ctx.init(createAgent(() => ({ model: false })));

		await harness.shell('prepare workspace', { env: { TOKEN: 'secret' }, cwd: '/work' });

		expect(events.map((event) => event.type)).toEqual(['tool_start', 'tool_call']);
		expect(events[0]).toMatchObject({
			type: 'tool_start',
			instanceId: 'harness-shell-instance',
			harness: 'default',
			toolName: 'bash',
			args: { command: 'prepare workspace', cwd: '/work', env: { TOKEN: '<redacted>' } },
		});
		expect(events[0]?.session).toBeUndefined();
		expect(events[0]?.operationId).toBeUndefined();
		expect(events[1]).toMatchObject({ type: 'tool_call', toolName: 'bash', isError: false });
	});

	it('exposes compaction summarization calls as purpose-specific model turns', async () => {
		const provider = `faux-${crypto.randomUUID()}`;
		const modelId = 'compact';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({ provider, models: [{ id: modelId }] });
		registration.setResponses([
			fauxAssistantMessage('first answer'),
			fauxAssistantMessage('second answer'),
			fauxAssistantMessage('summary text'),
			fauxAssistantMessage('prefix summary'),
		]);
		const events: FlueEvent[] = [];

		try {
			const ctx = createFlueContext({
				id: 'compaction-instance',
				runId: undefined,
				payload: {},
				env: {},
				agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: (model) => model === modelSpecifier ? registration.getModel(modelId) : undefined },
				createDefaultEnv: async () => createEnv(),
				defaultStore: new InMemorySessionStore(),
			});
			ctx.subscribeEvent((event) => {
				events.push(event);
			});
			const harness = await ctx.init(createAgent(() => ({
				model: modelSpecifier,
				compaction: { keepRecentTokens: 0 },
			})));
			const session = await harness.session();

			await session.prompt('first input');
			await session.prompt('second input');
			await session.compact();

			const compactionRequests = events.filter((event): event is Extract<FlueEvent, { type: 'turn_request' }> => event.type === 'turn_request' && (event.purpose === 'compaction' || event.purpose === 'compaction_prefix'));
			const compactionTurns = events.filter((event): event is Extract<FlueEvent, { type: 'turn' }> => event.type === 'turn' && (event.purpose === 'compaction' || event.purpose === 'compaction_prefix'));
			expect(compactionRequests.map((event) => event.purpose).sort()).toEqual(['compaction', 'compaction_prefix']);
			expect(compactionTurns.map((event) => event.turnId).sort()).toEqual(compactionRequests.map((event) => event.turnId).sort());
			const compactionRequest = compactionRequests.find((event) => event.purpose === 'compaction');
			const compactionTurn = compactionTurns.find((event) => event.purpose === 'compaction');
			expect(compactionRequest?.turnId).toMatch(/^turn_/);
			expect(compactionRequest?.input.systemPrompt).toContain('summariz');
			expect(compactionTurn?.turnId).toBe(compactionRequest?.turnId);
			expect(compactionTurn?.output?.content).toEqual([{ type: 'text', text: 'summary text', textSignature: undefined }]);
			expect(events.some((event) => event.type === 'compaction_start')).toBe(true);
			expect(events.some((event) => event.type === 'compaction')).toBe(true);
		} finally {
			registration.unregister();
		}
	});

	it('correlates direct and dispatched input processing without workflow runs', async () => {
		const provider = `faux-${crypto.randomUUID()}`;
		const modelId = 'persistent';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({ provider, models: [{ id: modelId }] });
		registration.setResponses([
			fauxAssistantMessage('direct response'),
			fauxAssistantMessage('dispatch response'),
		]);

		try {
			const createContext = (dispatchId?: string) => createFlueContext({
				id: 'persistent-instance',
				runId: undefined,
				dispatchId,
				payload: {},
				env: {},
				agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: (model) => model === modelSpecifier ? registration.getModel(modelId) : undefined },
				createDefaultEnv: async () => createEnv(),
				defaultStore: new InMemorySessionStore(),
			});
			const agent = createAgent(() => ({ model: modelSpecifier }));

			const directEvents: FlueEvent[] = [];
			const directCtx = createContext();
			directCtx.subscribeEvent((event) => { directEvents.push(event); });
			const directTools: DirectAgentToolDeclaration[] = [{
				name: 'lookup',
				description: 'Look up direct-agent data.',
				parameters: { type: 'object', properties: { query: { type: 'string' } } },
				kind: 'client',
			}];
			const directSession = await (await directCtx.init(agent)).session() as FlueSession & { processDirectInput(input: { message: string; tools?: DirectAgentToolDeclaration[] }): PromiseLike<unknown> };
			await directSession.processDirectInput({ message: 'direct input', tools: directTools });

			const dispatchEvents: FlueEvent[] = [];
			const dispatchCtx = createContext('dispatch-1');
			dispatchCtx.subscribeEvent((event) => { dispatchEvents.push(event); });
			const dispatchSession = await (await dispatchCtx.init(agent)).session() as FlueSession & { processDispatchInput(input: DispatchInput): PromiseLike<unknown> };
			await dispatchSession.processDispatchInput({
				dispatchId: 'dispatch-1',
				targetAgent: 'assistant',
				agent: 'assistant',
				id: 'persistent-instance',
				session: 'default',
				input: { message: 'dispatch input' },
				acceptedAt: '2026-05-24T00:00:00.000Z',
			});

			for (const events of [directEvents, dispatchEvents]) {
				expect(events.some((event) => event.type === 'operation_start')).toBe(true);
				expect(events.some((event) => event.type === 'operation')).toBe(true);
				expect(events.some((event) => event.type === 'idle')).toBe(true);
				expect(events.every((event) => event.runId === undefined)).toBe(true);
			}
			expect(directEvents.find((event) => event.type === 'turn_request')?.instanceId).toBe('persistent-instance');
			expect(directEvents.find((event): event is Extract<FlueEvent, { type: 'turn_request' }> => event.type === 'turn_request')?.input.tools?.find((tool) => tool.name === 'lookup')).toMatchObject({
				name: 'lookup',
				description: 'Look up direct-agent data.',
				parameters: directTools[0]?.parameters,
			});
			expect(dispatchEvents.find((event) => event.type === 'turn_request')?.dispatchId).toBe('dispatch-1');
		} finally {
			registration.unregister();
		}
	});

	it('runs model-invoked tasks within the owning prompt operation', async () => {
		const provider = `faux-${crypto.randomUUID()}`;
		const modelId = 'task-tool';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({ provider, models: [{ id: modelId }] });
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall('task', { prompt: 'Research this.' }), { stopReason: 'toolUse' }),
			fauxAssistantMessage(fauxText('child answer')),
			(context) => {
				const toolResult = context.messages.findLast((message) => message.role === 'toolResult');
				return fauxAssistantMessage(fauxText(toolResult?.role === 'toolResult' ? 'used child answer' : 'missing task result'));
			},
		]);
		const events: FlueEvent[] = [];

		try {
			const ctx = createFlueContext({
				id: 'task-tool-instance',
				runId: undefined,
				payload: {},
				env: {},
				agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: (model) => model === modelSpecifier ? registration.getModel(modelId) : undefined },
				createDefaultEnv: async () => createEnv(),
				defaultStore: new InMemorySessionStore(),
			});
			ctx.subscribeEvent((event) => { events.push(event); });
			const session = await (await ctx.init(createAgent(() => ({ model: modelSpecifier })))).session();

			const result = await session.prompt('Use a task.');

			expect(result.text).toBe('used child answer');
			expect(events.find((event) => event.type === 'task_start')).toMatchObject({ prompt: 'Research this.' });
			expect(events.find((event) => event.type === 'task')).toMatchObject({ isError: false, result: 'child answer' });
			const operations = events.filter((event) => event.type === 'operation_start');
			expect(operations.some((event) => event.operationKind === 'task')).toBe(false);
			expect(operations.filter((event) => event.session === 'default')).toEqual([
				expect.objectContaining({ operationKind: 'prompt' }),
			]);
		} finally {
			registration.unregister();
		}
	});

	it('correlates multiple tool-mediated turns within one operation', async () => {
		const provider = `faux-${crypto.randomUUID()}`;
		const modelId = 'tools';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({ provider, models: [{ id: modelId }] });
		registration.setResponses([
			fauxAssistantMessage(fauxToolCall('lookup', { query: 'record' }), { stopReason: 'toolUse' }),
			(context) => {
				const toolResult = context.messages.findLast((message) => message.role === 'toolResult');
				return fauxAssistantMessage(fauxText(toolResult?.role === 'toolResult' ? 'done' : 'missing'));
			},
		]);
		const events: FlueEvent[] = [];

		try {
			const ctx = createFlueContext({
				id: 'tool-instance',
				runId: undefined,
				payload: {},
				env: {},
				agentConfig: { systemPrompt: '', skills: {}, model: undefined, resolveModel: (model) => model === modelSpecifier ? registration.getModel(modelId) : undefined },
				createDefaultEnv: async () => createEnv(),
				defaultStore: new InMemorySessionStore(),
			});
			ctx.subscribeEvent((event) => {
				events.push(event);
			});
			const harness = await ctx.init(createAgent(() => ({
				model: modelSpecifier,
				tools: [{
					name: 'lookup',
					description: 'Look up a record.',
					parameters: Type.Object({ query: Type.String() }),
					execute: async () => 'record found',
				}],
			})));
			const session = await harness.session();

			await session.prompt('Use a tool.');

			const requests = events.filter((event): event is Extract<FlueEvent, { type: 'turn_request' }> => event.type === 'turn_request');
			const turns = events.filter((event): event is Extract<FlueEvent, { type: 'turn' }> => event.type === 'turn');
			expect(requests).toHaveLength(2);
			expect(turns).toHaveLength(2);
			expect(new Set(requests.map((event) => event.turnId)).size).toBe(2);
			expect(turns.map((event) => event.turnId)).toEqual(requests.map((event) => event.turnId));
			expect(new Set(requests.map((event) => event.operationId)).size).toBe(1);
			expect(requests[1]?.input.messages.some((message) => message.role === 'toolResult')).toBe(true);
			const toolEvent = events.find((event) => event.type === 'tool_call');
			expect(toolEvent?.turnId).toBe(requests[0]?.turnId);
		} finally {
			registration.unregister();
		}
	});
});
