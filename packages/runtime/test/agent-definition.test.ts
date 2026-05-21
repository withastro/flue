import { Type } from '@earendil-works/pi-ai';
import { describe, expect, it } from 'vitest';
import { defineAgent, resolveAgentDefinition } from '../src/agent-definition.ts';
import { defineTool } from '../src/tool.ts';

describe('defineAgent', () => {
	it('returns the provided agent definition', () => {
		const tool = defineTool({
			name: 'lookup',
			description: 'Look up a value.',
			parameters: Type.Object({ value: Type.String() }),
			execute: async () => 'ok',
		});

		const definition = {
			model: 'anthropic/claude-sonnet-4-6',
			instructions: 'Help the user.',
			skills: [{ name: 'triage', description: 'Triage requests.' }],
			tools: [tool],
		};

		expect(defineAgent(definition)).toBe(definition);
	});

	it('accepts an empty definition', () => {
		const definition = {};

		expect(defineAgent(definition)).toBe(definition);
	});

	it.each([
		[{ model: 123 }, 'valid agent definition'],
		[{ instructions: false }, 'valid agent definition'],
		[{ thinkingLevel: 'turbo' }, 'thinkingLevel'],
		[{ compaction: { reserveTokens: 'lots' } }, 'compaction.reserveTokens'],
		[{ compaction: { reserveTokens: -1 } }, 'non-negative integer'],
		[{ compaction: { reserveTokens: Number.NaN } }, 'non-negative integer'],
		[{ compaction: { keepRecentTokens: Number.POSITIVE_INFINITY } }, 'non-negative integer'],
		[{ compaction: { keepRecentTokens: 1.5 } }, 'non-negative integer'],
		[{ instruction: 'Typo.' }, 'unknown agent definition field'],
		[{ skills: [{ description: 'Missing name.' }] }, 'skills[0].name'],
		[{ skills: [{ name: ' ', description: 'Blank name.' }] }, 'skills[0].name'],
		[{ skills: [{ name: 'triage' }] }, 'skills[0].description'],
		[{ tools: [{ name: 123 }] }, 'tools[0].name'],
		[{ tools: [{ name: ' ', description: 'Desc', parameters: {}, execute: async (): Promise<string> => 'ok' }] }, 'tools[0].name'],
		[{ tools: [{ name: 'tool', parameters: {}, execute: async (): Promise<string> => 'ok' }] }, 'tools[0].description'],
		[{ tools: [{ name: 'tool', description: 'Desc', execute: async (): Promise<string> => 'ok' }] }, 'tools[0].parameters'],
		[{ tools: [{ name: 'tool', description: 'Desc', parameters: {} }] }, 'tools[0].execute'],
	])('rejects invalid definitions %#', (definition, message) => {
		expect(() => defineAgent(definition as never)).toThrow(String(message));
	});

	it('rejects duplicate tool names', () => {
		const tool = {
			name: 'lookup',
			description: 'Look up a value.',
			parameters: {},
			execute: async () => 'ok',
		};

		expect(() => defineAgent({ tools: [tool, tool] })).toThrow('duplicate tool name "lookup"');
	});

	it('rejects duplicate skill names', () => {
		expect(() =>
			defineAgent({
				skills: [
					{ name: 'triage', description: 'Triage requests.' },
					{ name: 'triage', description: 'Triage other requests.' },
				],
			}),
		).toThrow('duplicate skill name "triage"');
	});

	it('accepts named nested subagents and rejects duplicate names', () => {
		const reviewer = defineAgent({ name: 'reviewer', model: false });
		const writer = defineAgent({ name: 'writer', model: false, subagents: [reviewer] });

		expect(defineAgent({ name: 'triage', model: false, subagents: [writer] }).subagents).toEqual([writer]);
		expect(() => defineAgent({ subagents: [reviewer, reviewer] })).toThrow('duplicate subagent name "reviewer"');
	});

});

describe('resolveAgentDefinition', () => {
	it('inherits definition fields and lets init-level fields replace them', () => {
		const inheritedSkills = [{ name: 'base', description: 'Base skill.' }];
		const overrideSkills = [{ name: 'override', description: 'Override skill.' }];
		expect(
			resolveAgentDefinition({
				inherit: {
					model: 'anthropic/claude-sonnet-4-6',
					instructions: 'Inherited instructions.',
					skills: inheritedSkills,
				},
				instructions: undefined,
				skills: overrideSkills,
			}),
		).toEqual({
			name: undefined,
			description: undefined,
			model: 'anthropic/claude-sonnet-4-6',
			instructions: undefined,
			skills: overrideSkills,
			tools: undefined,
			subagents: undefined,
			thinkingLevel: undefined,
			compaction: undefined,
		});
	});
});
