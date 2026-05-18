import { describe, expect, it } from 'vitest';
import { Harness } from '../src/harness.ts';
import { InMemorySessionStore } from '../src/session.ts';
import { defineAgent } from '../src/definition.ts';
import { defineTool } from '../src/tool.ts';
import type { AgentConfig, SessionEnv, SkillDefinition } from '../src/types.ts';

const sandboxSkill: SkillDefinition = {
	name: 'sandbox-review',
	description: 'Review sandbox files.',
	body: 'Review files.',
	source: { kind: 'sandbox', cwd: '/repo', relativePath: '.agents/skills/sandbox-review' },
};

const env: SessionEnv = {
	cwd: '/repo',
	resolvePath: (path) => (path.startsWith('/') ? path : `/repo/${path}`),
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

describe('task session sandbox context', () => {
	it('persists harness sessions under the action session key prefix', async () => {
		const keys: string[] = [];
		const store = {
			load: async () => null,
			save: async (key: string) => {
				keys.push(key);
			},
			delete: async () => {},
		};
		const harness = new Harness(
			'hello',
			'inst-1',
			'default',
			{
				systemPrompt: '',
				skills: {},
				sandboxSkills: {},
				sandboxSkillDiscoveryHint: false,
				subagents: {},
				model: undefined,
				resolveModel: () => undefined,
			},
			env,
			store,
		);

		await harness.session();
		expect(keys[0]).toBe('action-session:["hello","inst-1","default","default"]');
	});

	it('keeps same instance ids isolated across actions', async () => {
		const keys: string[] = [];
		const store = {
			load: async () => null,
			save: async (key: string) => {
				keys.push(key);
			},
			delete: async () => {},
		};
		const config: AgentConfig = {
			systemPrompt: '',
			skills: {},
			sandboxSkills: {},
			sandboxSkillDiscoveryHint: false,
			subagents: {},
			model: undefined,
			resolveModel: () => undefined,
		};
		const summarize = new Harness('summarize', 'customer-42', 'default', config, env, store);
		const chat = new Harness('chat', 'customer-42', 'default', config, env, store);

		await summarize.session();
		await chat.session();

		expect(keys).toEqual([
			'action-session:["summarize","customer-42","default","default"]',
			'action-session:["chat","customer-42","default","default"]',
		]);
	});

	it('inherits workspace context and sandbox skills for task agents', async () => {
		const config: AgentConfig = {
			systemPrompt: '',
			workspaceContext: 'Repository context.',
			skills: { 'sandbox-review': sandboxSkill },
			sandboxSkills: { 'sandbox-review': sandboxSkill },
			sandboxSkillDiscoveryHint: false,
			subagents: {},
			model: undefined,
			resolveModel: () => undefined,
		};
		const harness = new Harness('hello', 'agent', 'default', config, env, new InMemorySessionStore());
		const taskSession = await (harness as unknown as {
			createTaskSession(options: {
				parentSession: string;
				taskId: string;
				parentEnv: SessionEnv;
				agent: ReturnType<typeof defineAgent>;
				depth: number;
			}): Promise<{ config: AgentConfig }>;
		}).createTaskSession({
			parentSession: 'default',
			taskId: 'task',
			parentEnv: env,
			agent: defineAgent({ name: 'child', instructions: 'Child instructions.' }),
			depth: 1,
		});
		const taskConfig = taskSession.config;
		expect(taskConfig.systemPrompt).toContain('Child instructions.');
		expect(taskConfig.systemPrompt).toContain('Repository context.');
		expect(taskConfig.skills['sandbox-review']).toBe(sandboxSkill);
	});

	it('uses delegated agent tools instead of parent harness tools', async () => {
		const parentTool = defineTool({
			name: 'parent-tool',
			description: 'Parent tool.',
			parameters: { type: 'object' },
			execute: async () => 'parent',
		});
		const childTool = defineTool({
			name: 'child-tool',
			description: 'Child tool.',
			parameters: { type: 'object' },
			execute: async () => 'child',
		});
		const config: AgentConfig = {
			systemPrompt: '',
			skills: {},
			sandboxSkills: {},
			sandboxSkillDiscoveryHint: false,
			subagents: {},
			model: undefined,
			resolveModel: () => undefined,
		};
		const harness = new Harness('hello', 'agent', 'default', config, env, new InMemorySessionStore(), undefined, [parentTool]);
		const taskSession = await (harness as unknown as {
			createTaskSession(options: {
				parentSession: string;
				taskId: string;
				parentEnv: SessionEnv;
				agent: ReturnType<typeof defineAgent>;
				depth: number;
			}): Promise<{ agentTools: Array<{ name: string }> }>;
		}).createTaskSession({
			parentSession: 'default',
			taskId: 'task',
			parentEnv: env,
			agent: defineAgent({ name: 'child', tools: [childTool] }),
			depth: 1,
		});
		expect(taskSession.agentTools.map((tool) => tool.name)).toEqual(['child-tool']);
	});

	it('keeps parent harness tools for generic task sessions', async () => {
		const parentTool = defineTool({
			name: 'parent-tool',
			description: 'Parent tool.',
			parameters: { type: 'object' },
			execute: async () => 'parent',
		});
		const config: AgentConfig = {
			systemPrompt: '',
			skills: {},
			sandboxSkills: {},
			sandboxSkillDiscoveryHint: false,
			subagents: {},
			model: undefined,
			resolveModel: () => undefined,
		};
		const harness = new Harness('hello', 'agent', 'default', config, env, new InMemorySessionStore(), undefined, [parentTool]);
		const taskSession = await (harness as unknown as {
			createTaskSession(options: {
				parentSession: string;
				taskId: string;
				parentEnv: SessionEnv;
				depth: number;
			}): Promise<{ agentTools: Array<{ name: string }> }>;
		}).createTaskSession({
			parentSession: 'default',
			taskId: 'task',
			parentEnv: env,
			depth: 1,
		});
		expect(taskSession.agentTools.map((tool) => tool.name)).toEqual(['parent-tool']);
	});
});
