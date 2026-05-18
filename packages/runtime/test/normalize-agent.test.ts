import { describe, expect, it } from 'vitest';
import { defineAgent, normalizeAgentDefinition } from '../src/definition.ts';
import { defineTool } from '../src/tool.ts';

const skill = {
	name: 'summarize',
	description: 'Summarize text.',
	body: 'Summarize it.',
	source: { kind: 'local' as const, path: '/tmp/summarize/SKILL.md' },
};
const inlineSkill = { ...skill, name: 'inline' };
const tool = defineTool({
	name: 'lookup',
	description: 'Look something up.',
	parameters: { type: 'object' },
	execute: async () => 'ok',
});
const inlineTool = defineTool({ ...tool, name: 'debug' });
const child = defineAgent({ name: 'child' });
const inlineChild = defineAgent({ name: 'inline-child' });

describe('normalizeAgentDefinition', () => {
	it('keeps a defined agent intact', () => {
		const agent = defineAgent({ name: 'triage', model: 'anthropic/test', skills: [skill], tools: [tool], subagents: [child] });
		const normalized = normalizeAgentDefinition({ agent });
		expect(normalized.name).toBe('triage');
		expect(normalized.model).toBe('anthropic/test');
		expect(normalized.skills).toEqual([skill]);
	});

	it('constructs inline agents and merges additive resources', () => {
		const agent = defineAgent({ name: 'triage', skills: [skill], tools: [tool], subagents: [child] });
		const normalized = normalizeAgentDefinition({
			agent,
			model: 'anthropic/override',
			skills: [inlineSkill],
			tools: [inlineTool],
			subagents: [inlineChild],
		});
		expect(normalized.model).toBe('anthropic/override');
		expect(normalized.skills?.map((entry) => entry.name)).toEqual(['summarize', 'inline']);
		expect(normalized.tools?.map((entry) => entry.name)).toEqual(['lookup', 'debug']);
		expect(normalized.subagents?.map((entry) => entry.name)).toEqual(['child', 'inline-child']);
	});

	it('catches cross-source duplicates', () => {
		const agent = defineAgent({ name: 'triage', skills: [skill], tools: [tool], subagents: [child] });
		expect(() => normalizeAgentDefinition({ agent, skills: [skill] })).toThrow('Skill name "summarize"');
		expect(() => normalizeAgentDefinition({ agent, tools: [tool] })).toThrow('Tool name "lookup"');
		expect(() => normalizeAgentDefinition({ agent, subagents: [child] })).toThrow('Subagent name "child"');
	});

	it('suppresses agent models when model false is passed', () => {
		const agent = defineAgent({ name: 'triage', model: 'anthropic/test' });
		expect(normalizeAgentDefinition({ agent, model: false }).model).toBeUndefined();
	});
});
