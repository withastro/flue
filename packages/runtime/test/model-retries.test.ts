import { fauxAssistantMessage, fauxText, registerFauxProvider } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createAgent, defineAgentProfile } from '../src/agent-definition.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { SessionEnv } from '../src/types.ts';

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

describe('modelRetries', () => {
	it('retries transient provider errors from a prompt turn', async () => {
		const provider = `retry-${crypto.randomUUID()}`;
		const modelId = 'overloaded';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({
			provider,
			models: [{ id: modelId }],
		});
		registration.setResponses([
			fauxAssistantMessage(fauxText(''), {
				stopReason: 'error',
				errorMessage: '{"type":"overloaded_error","message":"Overloaded"}',
			}),
			fauxAssistantMessage('recovered'),
		]);

		try {
			const ctx = createFlueContext({
				id: 'retry-transient',
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
				modelRetries: { maxRetries: 1, initialDelayMs: 0 },
			}));
			const harness = await ctx.init(agent);
			const session = await harness.session();

			const response = await session.prompt('Try once more.');

			expect(response.text).toBe('recovered');
			expect(registration.state.callCount).toBe(2);
		} finally {
			registration.unregister();
		}
	});

	it('does not retry quota and usage-limit failures', async () => {
		const provider = `retry-${crypto.randomUUID()}`;
		const modelId = 'quota';
		const modelSpecifier = `${provider}/${modelId}`;
		const registration = registerFauxProvider({
			provider,
			models: [{ id: modelId }],
		});
		registration.setResponses([
			fauxAssistantMessage(fauxText(''), {
				stopReason: 'error',
				errorMessage: 'You have reached your specified API usage limits.',
			}),
			fauxAssistantMessage('should not be used'),
		]);

		try {
			const ctx = createFlueContext({
				id: 'retry-quota',
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
				modelRetries: { maxRetries: 2, initialDelayMs: 0 },
			}));
			const harness = await ctx.init(agent);
			const session = await harness.session();

			await expect(session.prompt('Try once more.')).rejects.toThrow('You have reached your specified API usage limits.');
			expect(registration.state.callCount).toBe(1);
		} finally {
			registration.unregister();
		}
	});

	it('validates retry config fields', () => {
		expect(() =>
			defineAgentProfile({
				name: 'bad-retry',
				modelRetries: { maxRetries: -1 },
			}),
		).toThrow('modelRetries.maxRetries must be a non-negative integer');
	});
});
