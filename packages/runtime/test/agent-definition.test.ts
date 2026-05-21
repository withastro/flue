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
			subagents: [{ name: 'delegate', model: false as const }],
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
		[{ subagents: [{ model: 123 }] }, 'subagents[0].name'],
		[{ subagents: [{ name: '1bad', model: false }] }, 'must start with a letter'],
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

	it('rejects circular subagents', () => {
		const definition = { name: 'loop' } as { name: string; subagents?: unknown[] };
		definition.subagents = [definition];

		expect(() => defineAgent(definition as never)).toThrow('circular subagents');
	});
});

describe('resolveAgentDefinition', () => {
	it('inherits definition fields and lets own init fields replace them', () => {
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
