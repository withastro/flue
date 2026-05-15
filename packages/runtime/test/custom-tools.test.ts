import { describe, expect, it } from 'vitest';
import { toAgentToolResult } from '../src/session.ts';

describe('custom tool results', () => {
	it('wraps string results as text content', () => {
		expect(toAgentToolResult('lookup', 'hello')).toEqual({
			content: [{ type: 'text', text: 'hello' }],
			details: { customTool: 'lookup' },
		});
	});

	it('preserves structured content and details', () => {
		const result = toAgentToolResult('screenshot', {
			content: [
				{ type: 'text', text: 'screenshot captured' },
				{ type: 'image', data: 'abc123', mimeType: 'image/png' },
			],
			details: { nodeId: 'page:page' },
		});

		expect(result).toEqual({
			content: [
				{ type: 'text', text: 'screenshot captured' },
				{ type: 'image', data: 'abc123', mimeType: 'image/png' },
			],
			details: { nodeId: 'page:page' },
		});
	});

	it('rejects invalid structured results', () => {
		expect(() =>
			toAgentToolResult('metadata', {
				details: { nodeId: 'page:page' },
			} as never),
		).toThrow('Custom tool "metadata" returned an invalid result');
	});
});
