import { describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { createTools } from '../src/agent.ts';
import { defineTool } from '../src/tool.ts';
import type { AgentToolResult } from '@earendil-works/pi-agent-core';
import type { SessionEnv } from '../src/types.ts';

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
		const tools = createTools({} as SessionEnv, {
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
		await taskTool!.execute('tool-1', { prompt: 'Review this.', agent: 'code_review' });
		expect(calls).toEqual(['code_review']);
	});
});
