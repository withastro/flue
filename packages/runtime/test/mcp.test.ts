import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { connectMcpServer } from '../src/index.ts';
import { connectMcpServerWithClient } from '../src/mcp.ts';

const transport = {} as Transport;
const mcp = {
	connectError: undefined as Error | undefined,
	listToolsError: undefined as Error | undefined,
	listToolsResults: [] as Array<{ tools: Tool[]; nextCursor?: string }>,
	listToolsResult: { tools: [] } as { tools: Tool[]; nextCursor?: string },
	callToolResult: { content: [] } as CallToolResult,
	client: {
		callTool: vi.fn(async () => mcp.callToolResult),
		close: vi.fn(async () => {}),
		connect: vi.fn(async () => {
			if (mcp.connectError) throw mcp.connectError;
		}),
		listTools: vi.fn(async () => {
			if (mcp.listToolsError) throw mcp.listToolsError;
			return mcp.listToolsResults.shift() ?? mcp.listToolsResult;
		}),
	},
};

beforeEach(() => {
	vi.clearAllMocks();
	mcp.connectError = undefined;
	mcp.listToolsError = undefined;
	mcp.listToolsResults.length = 0;
	mcp.listToolsResult = { tools: [] };
	mcp.callToolResult = { content: [] };
});

describe('connectMcpServerWithClient()', () => {
	it('exposes listed MCP tools as Flue tools when a server connection succeeds', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'lookup',
					description: 'Find a catalog entry.',
					inputSchema: {
						type: 'object',
						properties: { query: { type: 'string' } },
						required: ['query'],
					},
				},
			],
		};

		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		expect(mcp.client.connect).toHaveBeenCalledWith(transport);
		expect(connection.name).toBe('catalog');
		expect(connection.tools).toEqual([
			expect.objectContaining({
				name: 'mcp__catalog__lookup',
				description: expect.stringContaining('Find a catalog entry.'),
				parameters: {
					type: 'object',
					properties: { query: { type: 'string' } },
					required: ['query'],
				},
				execute: expect.any(Function),
			}),
		]);
	});

	it('exposes tools from every tools/list page when MCP discovery is paginated', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'lookup',
						inputSchema: { type: 'object' },
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [
					{
						name: 'refresh',
						inputSchema: { type: 'object' },
					},
				],
				nextCursor: '',
			},
			{
				tools: [
					{
						name: 'inspect',
						inputSchema: { type: 'object' },
					},
				],
			},
		];

		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		expect(connection.tools.map((tool) => tool.name)).toEqual([
			'mcp__catalog__lookup',
			'mcp__catalog__refresh',
			'mcp__catalog__inspect',
		]);
		expect(mcp.client.listTools).toHaveBeenNthCalledWith(1);
		expect(mcp.client.listTools).toHaveBeenNthCalledWith(2, { cursor: 'catalog-page-2' });
		expect(mcp.client.listTools).toHaveBeenNthCalledWith(3, { cursor: '' });
	});

	it('namespaces and sanitizes tool names when server or tool names contain unsupported characters', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: ' find.value ',
					inputSchema: { type: 'object' },
				},
			],
		};

		const connection = await connectMcpServerWithClient(' docs/API ', mcp.client, transport);

		expect(connection.tools[0]?.name).toBe('mcp__docs_API__find_value');
	});

	it('rejects adapted tools when sanitization produces duplicate names across pages', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'read/value',
						inputSchema: { type: 'object' },
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [
					{
						name: 'read value',
						inputSchema: { type: 'object' },
					},
				],
			},
		];

		await expect(connectMcpServerWithClient('catalog', mcp.client, transport)).rejects.toThrow(
			'[flue] MCP tools from server "catalog" produced duplicate tool name "mcp__catalog__read_value".',
		);
		expect(mcp.client.close).toHaveBeenCalledOnce();
	});

	it('returns a usable object parameter schema when an MCP tool omits optional object schema fields', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'refresh',
					inputSchema: { type: 'object' },
				},
			],
		};

		const connection = await connectMcpServerWithClient('cache', mcp.client, transport);

		expect(connection.tools[0]?.parameters).toEqual({
			type: 'object',
			properties: {},
			required: undefined,
		});
	});

	it('forwards arguments and abort signals when an adapted MCP tool executes', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'lookup',
					inputSchema: {
						type: 'object',
						properties: { query: { type: 'string' } },
						required: ['query'],
					},
				},
			],
		};
		mcp.callToolResult = { content: [{ type: 'text', text: 'Found.' }] };
		const controller = new AbortController();
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		await connection.tools[0]?.execute({ query: 'flue' }, controller.signal);

		expect(mcp.client.callTool).toHaveBeenCalledWith(
			{
				name: 'lookup',
				arguments: { query: 'flue' },
			},
			undefined,
			{ signal: controller.signal },
		);
	});

	it("preserves supported MCP content in the adapted tool's readable text result when an MCP tool returns mixed content", async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'inspect',
					inputSchema: { type: 'object' },
				},
			],
		};
		mcp.callToolResult = {
			structuredContent: { count: 2 },
			content: [
				{ type: 'text', text: 'Inspection complete.' },
				{ type: 'image', mimeType: 'image/png', data: 'YWJj' },
				{ type: 'audio', mimeType: 'audio/wav', data: 'ZGVmZw==' },
				{ type: 'resource', resource: { uri: 'file:///report.txt', text: 'Report text.' } },
				{ type: 'resource', resource: { uri: 'file:///archive.zip', blob: 'aGk=' } },
				{
					type: 'resource_link',
					name: 'details',
					uri: 'https://mcp.example.test/details',
					description: 'Full details',
				},
			],
		};
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		const result = await connection.tools[0]?.execute({});

		expect(result).toContain('"count": 2');
		expect(result).toContain('Inspection complete.');
		expect(result).toContain('image/png');
		expect(result).toContain('audio/wav');
		expect(result).toContain('file:///report.txt');
		expect(result).toContain('Report text.');
		expect(result).toContain('file:///archive.zip');
		expect(result).toContain('details');
		expect(result).toContain('https://mcp.example.test/details');
		expect(result).toContain('Full details');
	});

	it('rejects malformed structured output when a schema-bearing MCP tool appears before the final listing page', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'lookup',
						inputSchema: { type: 'object' },
						outputSchema: {
							type: 'object',
							properties: { count: { type: 'number' } },
							required: ['count'],
						},
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [{ name: 'refresh', inputSchema: { type: 'object' } }],
			},
		];
		mcp.callToolResult = { content: [], structuredContent: { count: 'two' } };
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		await expect(connection.tools[0]?.execute({})).rejects.toThrow(
			"Structured content does not match the tool's output schema:",
		);
	});

	it('rejects missing structured output when a schema-bearing MCP tool appears before the final listing page', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'lookup',
						inputSchema: { type: 'object' },
						outputSchema: { type: 'object' },
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [{ name: 'refresh', inputSchema: { type: 'object' } }],
			},
		];
		mcp.callToolResult = { content: [] };
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		await expect(connection.tools[0]?.execute({})).rejects.toThrow(
			'Tool lookup has an output schema but did not return structured content',
		);
	});

	it('rejects ordinary execution when a required-task MCP tool appears before the final listing page', async () => {
		mcp.listToolsResults = [
			{
				tools: [
					{
						name: 'long-running',
						inputSchema: { type: 'object' },
						execution: { taskSupport: 'required' },
					},
				],
				nextCursor: 'catalog-page-2',
			},
			{
				tools: [{ name: 'refresh', inputSchema: { type: 'object' } }],
			},
		];
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		await expect(connection.tools[0]?.execute({})).rejects.toThrow(
			'Tool "long-running" requires task-based execution. Use client.experimental.tasks.callToolStream() instead.',
		);
		expect(mcp.client.callTool).not.toHaveBeenCalled();
	});

	it('throws tool output as an error when an MCP result marks itself as an error', async () => {
		mcp.listToolsResult = {
			tools: [
				{
					name: 'lookup',
					inputSchema: { type: 'object' },
				},
			],
		};
		mcp.callToolResult = {
			content: [{ type: 'text', text: 'Catalog unavailable.' }],
			isError: true,
		};
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		await expect(connection.tools[0]?.execute({})).rejects.toThrow('Catalog unavailable.');
	});

	it('closes the MCP client when connection setup fails', async () => {
		mcp.listToolsError = new Error('Tool discovery failed.');

		await expect(connectMcpServerWithClient('catalog', mcp.client, transport)).rejects.toThrow(
			'Tool discovery failed.',
		);
		expect(mcp.client.close).toHaveBeenCalledOnce();
	});

	it('closes the MCP client when the returned connection is closed', async () => {
		const connection = await connectMcpServerWithClient('catalog', mcp.client, transport);

		await connection.close();

		expect(mcp.client.close).toHaveBeenCalledOnce();
	});
});

describe('connectMcpServer()', () => {
	it('connects and invokes tools when the default streamable HTTP transport negotiates with a local MCP server', async () => {
		const local = await createLocalMcpServer();
		let connection: Awaited<ReturnType<typeof connectMcpServer>> | undefined;

		try {
			connection = await connectMcpServer('catalog', {
				url: local.url,
				fetch: local.fetch,
			});

			expect(connection.tools.map((tool) => tool.name)).toEqual(['mcp__catalog__lookup']);
			await expect(connection.tools[0]?.execute({})).resolves.toBe('Found.');
			expect(
				local.requests.some(
					(request) => request.headers.get('mcp-session-id') === 'fixture-session',
				),
			).toBe(true);
			expect(local.requests.some((request) => request.headers.has('mcp-protocol-version'))).toBe(
				true,
			);
		} finally {
			await Promise.allSettled([connection?.close(), local.close()]);
		}
	});
});

interface LocalMcpServer {
	url: string;
	fetch: typeof fetch;
	requests: Array<{ headers: Headers }>;
	close(): Promise<void>;
}

async function createLocalMcpServer(): Promise<LocalMcpServer> {
	const requests: LocalMcpServer['requests'] = [];
	const transport = new WebStandardStreamableHTTPServerTransport({
		enableJsonResponse: true,
		sessionIdGenerator: () => 'fixture-session',
	});
	const server = new McpServer({ name: 'local-test-server', version: '1.0.0' });
	server.registerTool('lookup', { description: 'Find a catalog entry.' }, async () => ({
		content: [{ type: 'text', text: 'Found.' }],
	}));
	await server.connect(transport);

	return {
		url: 'https://mcp.local.test/mcp',
		requests,
		fetch: async (input, init) => {
			const request = new Request(input, init);
			requests.push({ headers: new Headers(request.headers) });
			return transport.handleRequest(request);
		},
		close: () => server.close(),
	};
}
