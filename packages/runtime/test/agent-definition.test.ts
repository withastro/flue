import { describe, expect, it, vi } from 'vitest';
import {
	defineAgent,
	defineAction,
	defineAgentProfile,
	defineTool,
	ModelNotConfiguredError,
} from '../src/index.ts';
import type { FlueContextConfig } from '../src/internal.ts';
import { createFlueContext } from '../src/internal.ts';
import type { AgentProfile, AgentDefinition, ToolDefinition } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

function createContext(overrides: Partial<FlueContextConfig> = {}) {
	return createFlueContext({
		id: 'agent-instance',
		env: { API_KEY: 'secret' },
		agentConfig: {
			resolveModel: () => undefined,
		},
		createDefaultEnv: async () => createNoopSessionEnv(),
		...overrides,
	});
}

function createTool(name: string): ToolDefinition {
	return defineTool({
		name,
		description: `Run ${name}.`,
		run: async () => name,
	});
}

describe('defineAgent()', () => {
	it('rejects invalid input when it does not receive an initializer function', () => {
		expect(() => defineAgent(null as never)).toThrow('requires an initializer function');
	});

	it('invokes the initializer with id and env when a runner initializes the agent definition', async () => {
		const env = { API_KEY: 'secret' };
		const initialize = vi.fn(() => ({ model: false as const }));
		const ctx = createContext({ id: 'workflow-run', env });

		await ctx.initializeRootHarness(defineAgent(initialize));

		expect(initialize).toHaveBeenCalledOnce();
		expect(initialize).toHaveBeenCalledWith({ id: 'workflow-run', env });
	});

	it('rejects unknown runtime fields when an initializer returns unsupported configuration', async () => {
		const agent = defineAgent(() => ({ model: false, unsupported: true }) as never);

		await expect(createContext().initializeRootHarness(agent)).rejects.toThrow(
			'unknown runtime config field "unsupported"',
		);
	});

	it('rejects a top-level name when an initializer returns one', async () => {
		const agent = defineAgent(() => ({ model: false, name: 'support' }) as never);

		await expect(createContext().initializeRootHarness(agent)).rejects.toThrow(
			'unknown runtime config field "name"',
		);
	});

	it('rejects harness initialization when the initializer does not explicitly select a model or model false', async () => {
		await expect(createContext().initializeRootHarness(defineAgent(() => ({})))).rejects.toThrow(
			'defineAgent() requires a model',
		);
	});

	it('keeps an env-typed agent definition assignable to bare AgentDefinition positions', () => {
		interface Env {
			DB: { query(sql: string): unknown };
		}
		const typed = defineAgent<Env>(() => ({ model: false }));
		const bare: AgentDefinition = typed;

		expect(bare.__flueAgentDefinition).toBe(true);
	});
});

describe('defineAgentProfile()', () => {
	it('rejects unknown profile fields when a profile contains unsupported configuration', () => {
		expect(() => defineAgentProfile({ model: false, unsupported: true } as never)).toThrow(
			'unknown agent profile field "unsupported"',
		);
	});

	it('accepts Actions as first-class profile and runtime capabilities', async () => {
		const profileAction = defineAction({
			name: 'profile_action',
			description: 'Run the profile Action.',
			async run() {
				return undefined;
			},
		});
		const runtimeAction = defineAction({
			name: 'runtime_action',
			description: 'Run the runtime Action.',
			async run() {
				return undefined;
			},
		});
		const harness = await createContext().initializeRootHarness(
			defineAgent(() => ({
				profile: defineAgentProfile({ model: false, actions: [profileAction] }),
				actions: [runtimeAction],
			})),
		);

		expect(harness).toBeDefined();
	});

	it('rejects forged Actions in a profile', () => {
		expect(() =>
			defineAgentProfile({
				actions: [
					{
						__flueAction: true,
						name: 'forged',
						description: 'Forged.',
						run: async () => {},
					},
				],
			} as never),
		).toThrow('must be created with defineAction()');
	});

	it('rejects a skill when its description is missing', () => {
		expect(() => defineAgentProfile({ skills: [{ name: 'triage' }] } as never)).toThrow(
			'skills[0].description',
		);
	});

	it('rejects a tool when its run callback is missing', () => {
		expect(() =>
			defineAgentProfile({
				tools: [{ name: 'lookup', description: 'Look up a value.' }],
			} as never),
		).toThrow('tools[0] run');
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

	it('merges profile capabilities when an agent definition extends a reusable profile', async () => {
		const profile = defineAgentProfile({
			model: false,
			skills: [{ name: 'profile_skill', description: 'Profile skill.' }],
			tools: [createTool('profile_tool')],
			subagents: [{ name: 'profile_agent', model: false }],
		});
		const harness = await createContext().initializeRootHarness(
			defineAgent(() => ({
				profile,
				skills: [{ name: 'runtime_skill', description: 'Runtime skill.' }],
				tools: [createTool('runtime_tool')],
				subagents: [{ name: 'runtime_agent', model: false }],
			})),
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

	it('rejects duplicate tool names when an agent definition repeats a profile tool name', async () => {
		await expect(
			createContext().initializeRootHarness(
				defineAgent(() => ({
					profile: defineAgentProfile({ model: false, tools: [createTool('lookup')] }),
					tools: [createTool('lookup')],
				})),
			),
		).rejects.toThrow('duplicate tool name "lookup"');
	});

	it('replaces scalar profile defaults when an agent definition supplies scalar overrides', async () => {
		const profile = defineAgentProfile({ model: 'profile/model' });
		const harness = await createContext().initializeRootHarness(defineAgent(() => ({ profile, model: false })));
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

	it('accepts durability config when an agent definition supplies it', async () => {
		const harness = await createContext().initializeRootHarness(
			defineAgent(() => ({ model: false, durability: { maxAttempts: 3, timeoutMs: 7_200_000 } })),
		);
		expect(harness).toBeDefined();
	});
});
