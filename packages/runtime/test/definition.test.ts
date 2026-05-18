import { describe, expect, it } from 'vitest';
import { defineAgent } from '../src/definition.ts';
import { defineTool } from '../src/tool.ts';

const skill = {
	name: 'summarize',
	description: 'Summarize text.',
	body: 'Summarize it.',
	source: { kind: 'local' as const, path: '/tmp/summarize/SKILL.md' },
};

const tool = defineTool({
	name: 'lookup',
	description: 'Look something up.',
	parameters: { type: 'object' },
	execute: async () => 'ok',
});

describe('defineAgent', () => {
	it('returns a frozen agent and frozen resource arrays', () => {
		const child = defineAgent({ name: 'child' });
		const agent = defineAgent({ name: 'parent', skills: [skill], tools: [tool], subagents: [child] });
		expect(Object.isFrozen(agent)).toBe(true);
		expect(Object.isFrozen(agent.skills)).toBe(true);
		expect(Object.isFrozen(agent.tools)).toBe(true);
		expect(Object.isFrozen(agent.subagents)).toBe(true);
	});

	it('rejects invalid scalar fields', () => {
		expect(() => defineAgent({ name: '' })).toThrow('non-empty string');
		expect(() => defineAgent({ name: 'x', description: 1 as never })).toThrow('description');
		expect(() => defineAgent({ name: 'x', model: 1 as never })).toThrow('model');
		expect(() => defineAgent({ name: 'x', instructions: 1 as never })).toThrow('instructions');
	});

	it('rejects duplicate resource names', () => {
		expect(() => defineAgent({ name: 'x', skills: [skill, skill] })).toThrow('Duplicate skill name');
		expect(() => defineAgent({ name: 'x', tools: [tool, tool] })).toThrow('Duplicate tool name');
		const child = defineAgent({ name: 'child' });
		expect(() => defineAgent({ name: 'x', subagents: [child, child] })).toThrow('Duplicate subagent name');
	});
});
