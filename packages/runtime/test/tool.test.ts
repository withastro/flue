import { describe, expect, it } from 'vitest';
import { Type } from '@earendil-works/pi-ai';
import { defineTool } from '../src/tool.ts';

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
