import type { Client, Tool, Transport } from '@modelcontextprotocol/client';
import { describe, expect, it } from 'vitest';
import { createMcpConnectionWithClient } from './mcp.ts';
import { assertToolDefinition, defineTool } from './tool.ts';

/**
 * A stub MCP client: `createMcpConnectionWithClient` only needs listTools
 * (discovery), connect/close (lifecycle), and callTool (never reached in
 * these tests). Transport is never touched — the stub ignores it.
 */
function stubClient(tools: Tool[]): Pick<Client, 'callTool' | 'close' | 'connect' | 'listTools'> {
	return {
		connect: async () => {},
		close: async () => {},
		listTools: async () => ({ tools }),
		callTool: async () => ({ content: [] }),
	};
}

describe('MCP tool annotations', () => {
	it("carries the server's annotations through to the adapted tool definition", async () => {
		const connection = await createMcpConnectionWithClient(
			'test',
			stubClient([
				{
					name: 'create_issue',
					title: 'Create Issue',
					description: 'Creates a new issue.',
					inputSchema: { type: 'object', properties: {}, required: [] },
					annotations: {
						title: 'Create Issue',
						readOnlyHint: false,
						destructiveHint: true,
						idempotentHint: false,
						openWorldHint: false,
					},
				},
			]),
			{} as Transport,
		);

		expect(connection.tools).toHaveLength(1);
		const tool = connection.tools[0];
		if (!tool) throw new Error('Expected one adapted MCP tool.');
		expect(tool.name).toBe('mcp__test__create_issue');
		expect(tool.annotations).toEqual({
			title: 'Create Issue',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: false,
			openWorldHint: false,
		});
		expect(Object.isFrozen(tool.annotations)).toBe(true);
		expect(Object.isFrozen(tool)).toBe(true);
		// The existing description path still reads the annotation title.
		expect(tool.description).toContain('Title: Create Issue.');
	});

	it('omits annotations when the server declares none', async () => {
		const connection = await createMcpConnectionWithClient(
			'test',
			stubClient([
				{
					name: 'search_issues',
					description: 'Searches issues.',
					inputSchema: { type: 'object', properties: {}, required: [] },
				},
			]),
			{} as Transport,
		);

		expect(connection.tools[0]?.annotations).toBeUndefined();
		expect(connection.tools[0]?.name).toBe('mcp__test__search_issues');
	});

	it('accepts annotations on hand-written tool definitions', () => {
		const tool = defineTool({
			name: 'wipe_data',
			description: 'Deletes everything.',
			annotations: { destructiveHint: true },
			run: () => ({ output: 'wiped' }),
		});
		expect(tool.annotations).toEqual({ destructiveHint: true });
		expect(Object.isFrozen(tool.annotations)).toBe(true);
		// The same validation path useTool() runs accepts the field.
		expect(() => assertToolDefinition(tool, 'test')).not.toThrow();
	});

	it('rejects malformed annotations in the definition validation', () => {
		expect(() =>
			assertToolDefinition(
				{
					name: 'wipe_data',
					description: 'Deletes everything.',
					annotations: { destructiveHint: 'yes' },
					run: () => undefined,
				},
				'test',
			),
		).toThrow(/annotations\.destructiveHint must be a boolean/);

		expect(() =>
			assertToolDefinition(
				{
					name: 'wipe_data',
					description: 'Deletes everything.',
					annotations: { readOnlyhint: true },
					run: () => undefined,
				},
				'test',
			),
		).toThrow(/annotations received unknown field "readOnlyhint"/);
	});
});
