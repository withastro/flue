import { fauxAssistantMessage, registerFauxProvider, Type } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { FlueEvent, SessionEnv } from '../src/types.ts';

describe('turn_start events', () => {
	it('emits the LLM-visible input before streaming a turn', async () => {
		const provider = `faux-${crypto.randomUUID()}`;
		const modelId = 'faux-observer';
		const modelString = `${provider}/${modelId}`;
		const registration = registerFauxProvider({
			provider,
			models: [{ id: modelId, reasoning: true }],
			tokenSize: { min: 100, max: 100 },
		});
		registration.setResponses([
			fauxAssistantMessage('captured', { responseId: 'resp_123', timestamp: 123 }),
		]);

		try {
			const events: FlueEvent[] = [];
			const resolvePath = (path: string) => (path.startsWith('/') ? path : `/${path}`);
			const sessionEnv: SessionEnv = {
				cwd: '/',
				resolvePath,
				exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
				readFile: async () => '',
				readFileBuffer: async () => new Uint8Array(),
				writeFile: async () => {},
				stat: async () => ({
					isFile: false,
					isDirectory: false,
					isSymbolicLink: false,
					size: 0,
					mtime: new Date(0),
				}),
				readdir: async () => [],
				exists: async () => false,
				mkdir: async () => {},
				rm: async () => {},
			};
			const ctx = createFlueContext({
				id: 'agent-1',
				runId: 'run-1',
				payload: {},
				env: {},
				agentConfig: {
					systemPrompt: '',
					skills: {},
					roles: {},
					model: undefined,
					resolveModel: (model) => (model === modelString ? registration.getModel(modelId) : undefined),
				},
				createDefaultEnv: async () => sessionEnv,
				defaultStore: new InMemorySessionStore(),
			});
			ctx.subscribeEvent((event) => {
				events.push(event);
			});

			const harness = await ctx.init({
				model: modelString,
				thinkingLevel: 'high',
				tools: [
					{
						name: 'lookup',
						description: 'Lookup records by query.',
						parameters: Type.Object({ query: Type.String() }),
						execute: async () => 'not used',
					},
				],
			});
			const session = await harness.session();

			await session.prompt('What input reaches the model?');

			const turnStart = events.find(
				(event): event is Extract<FlueEvent, { type: 'turn_start' }> =>
					event.type === 'turn_start',
			);
			expect(turnStart).toBeDefined();
			expect(turnStart?.runId).toBe('run-1');
			expect(turnStart?.session).toBe('default');
			expect(turnStart?.harness).toBe('default');
			expect(turnStart?.operationId).toMatch(/^op_/);
			expect(turnStart?.turnId).toMatch(/^turn_/);
			expect(turnStart?.model).toBe(modelId);
			expect(turnStart?.provider).toBe(provider);
			expect(turnStart?.api).toBe(registration.api);
			expect(turnStart?.reasoning).toBe('high');

			const userMessage = turnStart?.input.messages[0];
			expect(userMessage?.role).toBe('user');
			expect(JSON.stringify(userMessage?.content)).toContain('What input reaches the model?');
			expect('timestamp' in ((userMessage ?? {}) as Record<string, unknown>)).toBe(false);
			const lookupTool = turnStart?.input.tools?.find((tool) => tool.name === 'lookup');
			expect(lookupTool).toMatchObject({
				name: 'lookup',
				description: 'Lookup records by query.',
			});
			expect('execute' in ((lookupTool ?? {}) as Record<string, unknown>)).toBe(false);

			const textDelta = events.find((event) => event.type === 'text_delta');
			const turn = events.find((event) => event.type === 'turn');
			expect(textDelta?.turnId).toBe(turnStart?.turnId);
			expect(turn?.turnId).toBe(turnStart?.turnId);
			if (turn?.type === 'turn') {
				expect(turn.provider).toBe(provider);
				expect(turn.api).toBe(registration.api);
				expect(turn.output?.content).toEqual([{ type: 'text', text: 'captured' }]);
				const output = (turn.output ?? {}) as Record<string, unknown>;
				expect('responseId' in output).toBe(false);
				expect('timestamp' in output).toBe(false);
				expect('usage' in output).toBe(false);
			}
			expect(events.findIndex((event) => event.type === 'turn_start')).toBeLessThan(
				events.findIndex((event) => event.type === 'text_delta'),
			);
		} finally {
			registration.unregister();
		}
	});
});
