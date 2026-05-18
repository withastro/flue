import { describe, expect, it } from 'vitest';
import { createTaskTool } from '../src/agent.ts';
import { defineAgent } from '../src/definition.ts';

describe('createTaskTool', () => {
	const runTask = async () => ({ content: [{ type: 'text' as const, text: 'ok' }], details: { taskId: 't', session: 's' } });

	it('omits agent schema when no subagents exist', () => {
		const tool = createTaskTool(runTask, {});
		expect((tool.parameters as any).properties.agent).toBeUndefined();
	});

	it('adds an agent enum for declared subagents', () => {
		const reviewer = defineAgent({ name: 'reviewer' });
		const triager = defineAgent({ name: 'triager' });
		const tool = createTaskTool(runTask, { reviewer, triager });
		expect((tool.parameters as any).properties.agent.enum).toEqual(['reviewer', 'triager']);
	});
});
