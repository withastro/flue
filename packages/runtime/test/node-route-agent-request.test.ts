import { describe, expect, it } from 'vitest';
import { InMemoryRegistrationStore, InMemorySessionStore, createNodeAgentRequestRouter } from '../src/internal.ts';
import type { Agent, AgentModule } from '../src/types.ts';

function createModule(options?: {
	init?: () => void;
	onMessage?: (message: string) => unknown | Promise<unknown>;
}): AgentModule {
	return {
		async init() {
			options?.init?.();
			return {
				name: 'hello',
				id: 'inst-1',
				send() {},
				harness() {
					throw new Error('not needed');
				},
			} satisfies Agent;
		},
		async onMessage(_agent, message) {
			return options?.onMessage?.(message.content);
		},
	};
}

function createRouter(agentModules: Record<string, AgentModule>, maxPendingMessages?: number) {
	return createNodeAgentRequestRouter({
		agentModules,
		maxPendingMessages,
		createContext({ agentName, instanceId, runId, payload, request }) {
			return {
				agentName,
				id: instanceId,
				runId,
				payload,
				env: {},
				req: request,
				agentConfig: {
					systemPrompt: '',
					skills: {},
					model: undefined,
					resolveModel: () => undefined,
				},
				createDefaultEnv: async () => ({}) as never,
				defaultStore: new InMemorySessionStore(),
				registrationStore: new InMemoryRegistrationStore(),
			};
		},
	});
}

describe('createNodeAgentRequestRouter', () => {
	it('returns raw JSON onMessage results and reuses init per instance', async () => {
		let initCalls = 0;
		const route = createRouter({
			hello: createModule({
				init: () => initCalls++,
				onMessage: (message) => ({ echoed: message }),
			}),
		});

		for (const message of ['one', 'two']) {
			const response = await route({
				request: new Request('http://localhost/agents/hello/inst-1', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ message, source: 'test' }),
				}),
				agentName: 'hello',
				instanceId: 'inst-1',
			});
			expect(response.status).toBe(200);
			expect(await response.json()).toEqual({ echoed: message });
		}

		expect(initCalls).toBe(1);
	});

	it('returns 204 for undefined delivery results', async () => {
		const route = createRouter({ hello: createModule() });
		const response = await route({
			request: new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hi' }),
			}),
			agentName: 'hello',
			instanceId: 'inst-1',
		});
		expect(response.status).toBe(204);
		expect(await response.text()).toBe('');
	});

	it('streams message lifecycle events over SSE', async () => {
		const route = createRouter({ hello: createModule({ onMessage: () => ({ ok: true }) }) });
		const response = await route({
			request: new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { accept: 'text/event-stream', 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'hi' }),
			}),
			agentName: 'hello',
			instanceId: 'inst-1',
		});
		expect(response.status).toBe(200);
		expect(response.headers.get('content-type')).toContain('text/event-stream');
		const body = await response.text();
		expect(body).toContain('event: message_start');
		expect(body).toContain('event: message_end');
		expect(body).toContain('"ok":true');
	});

	it('validates body shape and queue overflow at the HTTP boundary', async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const route = createRouter(
			{
				hello: createModule({
					async onMessage() {
						await gate;
						return { ok: true };
					},
				}),
			},
			1,
		);

		const invalid = await route({
			request: new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 123 }),
			}),
			agentName: 'hello',
			instanceId: 'inst-1',
		});
		expect(invalid.status).toBe(400);

		const first = route({
			request: new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'one' }),
			}),
			agentName: 'hello',
			instanceId: 'inst-1',
		});
		await Promise.resolve();
		const second = await route({
			request: new Request('http://localhost/agents/hello/inst-1', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ message: 'two' }),
			}),
			agentName: 'hello',
			instanceId: 'inst-1',
		});
		expect(second.status).toBe(429);
		release();
		expect((await first).status).toBe(200);
	});
});
