import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import { Type } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { createTools } from '../src/agent.ts';
import { Harness } from '../src/harness.ts';
import { InMemorySessionStore } from '../src/session.ts';
import { defineTool } from '../src/tool.ts';
import type { AgentConfig, FlueEvent, SessionEnv } from '../src/types.ts';

function createEnv(): SessionEnv {
	return {
		cwd: '/repo',
		resolvePath: (path) => (path.startsWith('/') ? path : `/repo/${path}`),
		exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
		readFile: async () => '',
		readFileBuffer: async () => new Uint8Array(),
		writeFile: async () => {},
		stat: async () => ({ isFile: true, isDirectory: false, isSymbolicLink: false, size: 0, mtime: new Date(0) }),
		readdir: async () => [],
		exists: async () => false,
		mkdir: async () => {},
		rm: async () => {},
	};
}

describe('defineTool', () => {
	it('returns a shallow-frozen cloned tool value', async () => {
		const parameters = Type.Object({ value: Type.String() });
		const execute = async () => 'ok';
		const input = {
			name: 'lookup',
			description: 'Look up a value.',
			parameters,
			execute,
		};

		const tool = defineTool(input);

		expect(tool).not.toBe(input);
		expect(Object.isFrozen(tool)).toBe(true);
		expect(tool.parameters).toBe(parameters);
		expect(tool.execute).toBe(execute);
		await expect(tool.execute({})).resolves.toBe('ok');
	});

	it.each([
		[null, 'requires a tool definition object'],
		[{ name: '', description: 'Desc', parameters: {}, execute: async () => 'ok' }, 'name'],
		[{ name: 'tool', description: '', parameters: {}, execute: async () => 'ok' }, 'description'],
		[{ name: 'tool', description: 'Desc', parameters: null, execute: async () => 'ok' }, 'parameters'],
		[{ name: 'tool', description: 'Desc', parameters: {}, execute: null }, 'execute'],
	])('rejects invalid definitions %#', (value, message) => {
		expect(() => defineTool(value as never)).toThrow(String(message));
	});
});

describe('subagent task selection', () => {
	it('passes the selected declared subagent name through task params', async () => {
		const calls: string[] = [];
		const tools = createTools(createEnv(), {
			subagents: {
				code_review: { name: 'code_review', model: false },
			},
			task: async (params): Promise<AgentToolResult<any>> => {
				calls.push(params.agent ?? 'generic');
				return { content: [{ type: 'text', text: 'ok' }], details: {} };
			},
		});

		const taskTool = tools.find((tool) => tool.name === 'task');
		expect(taskTool).toBeDefined();
		if (!taskTool) throw new Error('task tool missing');
		await taskTool.execute('tool-1', { prompt: 'Review this.', agent: 'code_review' });
		expect(calls).toEqual(['code_review']);
	});

	it('uses named subagent instructions, skills, and tools instead of parent defaults', async () => {
		const parentTool = defineTool({ name: 'parent_tool', description: 'Parent.', parameters: {}, execute: async () => 'parent' });
		const childTool = defineTool({ name: 'child_tool', description: 'Child.', parameters: {}, execute: async () => 'child' });
		const config: AgentConfig = {
			systemPrompt: 'parent prompt',
			instructions: 'Parent instructions.',
			definitionSkills: [{ name: 'parent_skill', description: 'Parent skill.' }],
			skills: {},
			subagents: {
				delegate: {
					name: 'delegate',
					instructions: 'Child instructions.',
					skills: [{ name: 'child_skill', description: 'Child skill.' }],
					tools: [childTool],
				},
			},
			model: undefined,
			resolveModel: () => undefined,
		};
		const harness = new Harness('instance', 'default', config, createEnv(), new InMemorySessionStore(), undefined, [parentTool]);
		const parent = await harness.session();
		const createTaskSession = Reflect.get(harness, 'createTaskSession').bind(harness) as (options: any) => Promise<any>;
		const child = await createTaskSession({
			parentSession: parent.name,
			taskId: 'task-agent-defaults',
			parentEnv: createEnv(),
			agent: config.subagents?.delegate,
			depth: 1,
		});
		const childConfig = Reflect.get(child, 'config') as AgentConfig;
		const childHarness = Reflect.get(child, 'harness') as { state: { tools: Array<{ name: string }> } };

		expect(childConfig.systemPrompt).toContain('Child instructions.');
		expect(childConfig.systemPrompt).toContain('child_skill');
		expect(childConfig.systemPrompt).not.toContain('Parent instructions.');
		expect(childConfig.systemPrompt).not.toContain('parent_skill');
		expect(childHarness.state.tools.map((tool) => tool.name)).toContain('child_tool');
		expect(childHarness.state.tools.map((tool) => tool.name)).not.toContain('parent_tool');
	});

	it('rejects unknown selected subagents before task lifecycle events', async () => {
		const events: FlueEvent[] = [];
		const harness = new Harness(
			'instance',
			'default',
			{ systemPrompt: '', skills: {}, subagents: {}, model: undefined, resolveModel: () => undefined },
			createEnv(),
			new InMemorySessionStore(),
			(event) => {
				events.push(event);
			},
		);
		const session = await harness.session();

		await expect(session.task('Delegate.', { agent: 'missing' })).rejects.toThrow('Subagent "missing" is not declared');
		expect(events.filter((event) => event.type === 'task_start' || event.type === 'task')).toEqual([]);
	});
});
