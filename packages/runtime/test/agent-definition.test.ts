import { describe, expect, it, vi } from 'vitest';
import {
	createAgent,
	defineAgentProfile,
	defineTool,
	ModelNotConfiguredError,
} from '../src/index.ts';
import type { FlueContextConfig } from '../src/internal.ts';
import { createFlueContext, InMemorySessionStore } from '../src/internal.ts';
import type { AgentProfile, CreatedAgent, FlueContext, ToolDefinition } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

function createContext(overrides: Partial<FlueContextConfig> = {}) {
	return createFlueContext({
		id: 'agent-instance',
		payload: { request: 'payload' },
		env: { API_KEY: 'secret' },
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		defaultStore: new InMemorySessionStore(),
		...overrides,
	});
}

function createTool(name: string): ToolDefinition {
	return defineTool({
		name,
		description: `Run ${name}.`,
		parameters: {},
		execute: async () => name,
	});
}

describe('createAgent()', () => {
	it('rejects invalid input when it does not receive an initializer function', () => {
		expect(() => createAgent(null as never)).toThrow('requires an initializer function');
	});

	it('invokes the initializer with id and env when a context initializes the created agent', async () => {
		const env = { API_KEY: 'secret' };
		const initialize = vi.fn(() => ({ model: false as const }));
		const ctx = createContext({ id: 'workflow-run', env, payload: { request: 'payload' } });

		await ctx.initializeCreatedAgent(createAgent(initialize));

		expect(initialize).toHaveBeenCalledOnce();
		expect(initialize).toHaveBeenCalledWith({ id: 'workflow-run', env });
	});

	it('rejects unknown runtime fields when an initializer returns unsupported configuration', async () => {
		const agent = createAgent(() => ({ model: false, unsupported: true }) as never);

		await expect(createContext().initializeCreatedAgent(agent)).rejects.toThrow(
			'Unknown agent runtime config field "unsupported"',
		);
	});

	it('rejects a top-level name when an initializer returns one', async () => {
		const agent = createAgent(() => ({ model: false, name: 'support' }) as never);

		await expect(createContext().initializeCreatedAgent(agent)).rejects.toThrow(
			'Unknown agent runtime config field "name"',
		);
	});

	it('rejects harness initialization when the initializer does not explicitly select a model or model false', async () => {
		await expect(createContext().init({})).rejects.toThrow('init() requires a model');
	});

	// Compile-time contract, enforced by `check:types` over this file: typed
	// created agents stay usable in untyped positions such as `dispatch(agent)`.
	it('keeps an env-typed created agent assignable to bare CreatedAgent positions', () => {
		interface Env {
			DB: { query(sql: string): unknown };
		}
		const typed = createAgent<Env>(() => ({ model: false }));
		const bare: CreatedAgent = typed;

		expect(bare.__flueCreatedAgent).toBe(true);
	});

	it('allows runtime config in workflows with different payload types', () => {
		interface Env {
			DB: { query(sql: string): unknown };
		}
		const initFromFirstWorkflow = (ctx: FlueContext<{ text: string }, Env>) =>
			ctx.init({ model: false });
		const initFromSecondWorkflow = (ctx: FlueContext<{ other: number }, Env>) =>
			ctx.init({ model: false });

		expect(initFromFirstWorkflow).toBeInstanceOf(Function);
		expect(initFromSecondWorkflow).toBeInstanceOf(Function);
	});
});

describe('defineAgentProfile()', () => {
	it('rejects unknown profile fields when a profile contains unsupported configuration', () => {
		expect(() => defineAgentProfile({ model: false, unsupported: true } as never)).toThrow(
			'unknown agent profile field "unsupported"',
		);
	});

	it('rejects a skill when its description is missing', () => {
		expect(() => defineAgentProfile({ skills: [{ name: 'triage' }] } as never)).toThrow(
			'skills[0].description',
		);
	});

	it('rejects a tool when its execute callback is missing', () => {
		expect(() =>
			defineAgentProfile({
				tools: [{ name: 'lookup', description: 'Look up a value.', parameters: {} }],
			} as never),
		).toThrow('tools[0].execute');
	});

	it('rejects a subagent when its name does not start with a letter', () => {
		expect(() => defineAgentProfile({ subagents: [{ name: '1invalid', model: false }] })).toThrow(
			'must start with a letter',
		);
	});

	it('rejects duplicate tool names when a profile repeats a tool name', () => {
		expect(() =>
			defineAgentProfile({ tools: [createTool('lookup'), createTool('lookup')] }),
		).toThrow('duplicate tool name');
	});

	it('rejects duplicate skill names when a profile repeats a skill name', () => {
		expect(() =>
			defineAgentProfile({
				skills: [
					{ name: 'triage', description: 'Triage requests.' },
					{ name: 'triage', description: 'Triage other requests.' },
				],
			}),
		).toThrow('duplicate skill name');
	});

	it('rejects duplicate subagent names when a profile repeats a subagent name', () => {
		expect(() =>
			defineAgentProfile({
				subagents: [
					{ name: 'delegate', model: false },
					{ name: 'delegate', model: false },
				],
			}),
		).toThrow('duplicate subagent name');
	});

	it('rejects circular profiles when subagents refer back to an active profile definition', () => {
		const profile = { name: 'loop' } as AgentProfile;
		profile.subagents = [profile];

		expect(() => defineAgentProfile(profile)).toThrow('circular subagents');
	});

	it('merges profile capabilities when a created agent extends a reusable profile', async () => {
		const profile = defineAgentProfile({
			model: false,
			skills: [{ name: 'profile_skill', description: 'Profile skill.' }],
			tools: [createTool('profile_tool')],
			subagents: [{ name: 'profile_agent', model: false }],
		});
		const harness = await createContext().init(
			{
				profile,
				skills: [{ name: 'runtime_skill', description: 'Runtime skill.' }],
				tools: [createTool('runtime_tool')],
				subagents: [{ name: 'runtime_agent', model: false }],
			},
		);
		const session = await harness.session();

		await expect(session.skill('profile_skill')).rejects.toThrow(ModelNotConfiguredError);
		await expect(session.skill('runtime_skill')).rejects.toThrow(ModelNotConfiguredError);
		await expect(session.task('Delegate work.', { agent: 'profile_agent' })).rejects.toThrow(
			ModelNotConfiguredError,
		);
		await expect(session.task('Delegate work.', { agent: 'runtime_agent' })).rejects.toThrow(
			ModelNotConfiguredError,
		);
	});

	it('rejects duplicate tool names when a created agent repeats a profile tool name', async () => {
		await expect(
			createContext().init(
				{
					profile: defineAgentProfile({ model: false, tools: [createTool('lookup')] }),
					tools: [createTool('lookup')],
				},
			),
		).rejects.toThrow('duplicate tool name "lookup"');
	});

	it('replaces scalar profile defaults when a created agent supplies scalar overrides', async () => {
		const profile = defineAgentProfile({ model: 'profile/model' });
		const harness = await createContext().init({ profile, model: false });
		const session = await harness.session();

		await expect(session.prompt('Answer without a model.')).rejects.toThrow(
			ModelNotConfiguredError,
		);
	});

	it('accepts valid durability config on a profile', () => {
		expect(() =>
			defineAgentProfile({ durability: { maxAttempts: 5, timeoutMs: 21_600_000 } }),
		).not.toThrow();
		expect(() => defineAgentProfile({ durability: {} })).not.toThrow();
	});

	it('rejects durability config with unknown fields', () => {
		expect(() =>
			defineAgentProfile({ durability: { maxAttempts: 5, unknown: true } } as never),
		).toThrow('unknown field "unknown"');
	});

	it('rejects durability config with non-positive maxAttempts', () => {
		expect(() => defineAgentProfile({ durability: { maxAttempts: 0 } })).toThrow(
			'positive integer',
		);
		expect(() => defineAgentProfile({ durability: { maxAttempts: -1 } })).toThrow(
			'positive integer',
		);
		expect(() => defineAgentProfile({ durability: { maxAttempts: 1.5 } })).toThrow(
			'positive integer',
		);
	});

	it('rejects durability config with non-positive timeoutMs', () => {
		expect(() => defineAgentProfile({ durability: { timeoutMs: 0 } })).toThrow('positive integer');
		expect(() => defineAgentProfile({ durability: { timeoutMs: -1 } })).toThrow('positive integer');
	});

	it('rejects durability config when declared on a subagent profile', () => {
		expect(() =>
			defineAgentProfile({
				subagents: [{ name: 'helper', model: false, durability: { maxAttempts: 3 } }],
			}),
		).toThrow('must not declare durability');
	});

	it('accepts durability config when a created agent supplies it', async () => {
		const harness = await createContext().init(
			{ model: false, durability: { maxAttempts: 3, timeoutMs: 7_200_000 } },
		);
		expect(harness).toBeDefined();
	});
});
