import { describe, expect, it } from 'vitest';
import { composeSystemPrompt } from '../src/context.ts';

describe('composeSystemPrompt', () => {
	it('places agent instructions before discovered workspace context', () => {
		const prompt = composeSystemPrompt(
			'Workspace guidance.',
			{},
			{ cwd: '/workspace' },
			'Agent instructions.',
		);

		expect(prompt.indexOf('Agent instructions.')).toBeLessThan(prompt.indexOf('Workspace guidance.'));
		expect(prompt).toContain('Working directory: /workspace');
	});
});
