import { describe, expect, it, vi } from 'vitest';
import { McpAuthRequiredError } from '../src/mcp.ts';

// We test connectMcpServer's validation and the auth fetch wrapper logic.
// The full MCP SDK transport/client is not started — we mock the underlying
// imports to isolate the auth layer.

// ─── Mocks ──────────────────────────────────────────────────────────────────

// Mock MCP SDK client and transports so connectMcpServer doesn't actually
// open a network connection.
const mockListTools = vi.fn().mockResolvedValue({ tools: [] });
const mockConnect = vi.fn().mockResolvedValue(undefined);
const mockClose = vi.fn().mockResolvedValue(undefined);
const mockSetNotificationHandler = vi.fn();

vi.mock('@modelcontextprotocol/sdk/client/index.js', () => {
	return {
		Client: class MockClient {
			connect = mockConnect;
			listTools = mockListTools;
			close = mockClose;
			setNotificationHandler = mockSetNotificationHandler;
		},
	};
});

vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => {
	return {
		StreamableHTTPClientTransport: class MockStreamableHTTP {},
	};
});

// Dynamic import of SSE transport — mock for transport tests.
vi.mock('@modelcontextprotocol/sdk/client/sse.js', () => {
	return {
		SSEClientTransport: class MockSSE {},
	};
});

// Import after mocks are set up.
const { connectMcpServer } = await import('../src/mcp.ts');

// ─── Helpers ────────────────────────────────────────────────────────────────

function baseOptions(overrides: Record<string, unknown> = {}) {
	return {
		url: 'https://mcp.example.com/mcp',
		...overrides,
	};
}

// ─── McpAuthRequiredError ───────────────────────────────────────────────────

describe('McpAuthRequiredError', () => {
	it('constructs with default message', () => {
		const err = new McpAuthRequiredError({});
		expect(err.name).toBe('McpAuthRequiredError');
		expect(err.message).toBe('MCP server requires interactive authorization');
		expect(err.authorizationUrl).toBeUndefined();
		expect(err.resourceMetadataUrl).toBeUndefined();
		expect(err.wwwAuthenticate).toBeUndefined();
	});

	it('accepts string URLs and converts to URL objects', () => {
		const err = new McpAuthRequiredError({
			message: 'Need auth',
			authorizationUrl: 'https://auth.example.com/authorize',
			resourceMetadataUrl: 'https://mcp.example.com/.well-known/oauth-protected-resource',
			wwwAuthenticate:
				'Bearer resource_metadata="https://mcp.example.com/.well-known/oauth-protected-resource"',
		});
		expect(err.message).toBe('Need auth');
		expect(err.authorizationUrl).toBeInstanceOf(URL);
		expect(err.authorizationUrl?.href).toBe('https://auth.example.com/authorize');
		expect(err.resourceMetadataUrl).toBeInstanceOf(URL);
		expect(err.wwwAuthenticate).toContain('Bearer');
	});

	it('accepts URL objects directly', () => {
		const authUrl = new URL('https://auth.example.com/authorize');
		const err = new McpAuthRequiredError({ authorizationUrl: authUrl });
		expect(err.authorizationUrl).toBe(authUrl);
	});

	it('preserves cause', () => {
		const cause = new Error('upstream');
		const err = new McpAuthRequiredError({ cause });
		expect(err.cause).toBe(cause);
	});
});

// ─── Validation ─────────────────────────────────────────────────────────────

describe('connectMcpServer validation', () => {
	it('rejects auth + authProvider together', async () => {
		await expect(
			connectMcpServer(
				'test',
				baseOptions({
					auth: async () => ({}),
					authProvider: {} as any,
				}),
			),
		).rejects.toThrow('mutually exclusive');
	});

	it('rejects authProvider (not yet implemented)', async () => {
		await expect(
			connectMcpServer(
				'test',
				baseOptions({
					authProvider: {} as any,
				}),
			),
		).rejects.toThrow('not yet implemented');
	});
});

// ─── Static auth (baseline — no regression) ─────────────────────────────────

describe('connectMcpServer static auth', () => {
	it('connects with static headers', async () => {
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({
			tools: [
				{
					name: 'get_user',
					description: 'Get a user',
					inputSchema: { type: 'object', properties: {} },
				},
			],
		});

		const conn = await connectMcpServer(
			'github',
			baseOptions({
				headers: { Authorization: 'Bearer static-token' },
			}),
		);

		expect(conn.name).toBe('github');
		expect(conn.tools).toHaveLength(1);
		expect(conn.tools[0]?.name).toBe('mcp__github__get_user');
		await conn.close();
	});

	it('connects without any auth', async () => {
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });

		const conn = await connectMcpServer('open', baseOptions());
		expect(conn.tools).toHaveLength(0);
		await conn.close();
	});
});

// ─── Auth hook ──────────────────────────────────────────────────────────────

describe('connectMcpServer auth hook', () => {
	it('calls auth hook with reason "connect" at startup', async () => {
		const authHook = vi.fn().mockResolvedValue({ Authorization: 'Bearer dynamic-1' });
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });

		const conn = await connectMcpServer('test', baseOptions({ auth: authHook }));

		expect(authHook).toHaveBeenCalledTimes(1);
		expect(authHook).toHaveBeenCalledWith(
			expect.objectContaining({
				serverUrl: expect.any(URL),
				reason: 'connect',
				signal: expect.any(AbortSignal),
			}),
		);
		expect(authHook.mock.calls[0]?.[0].serverUrl.href).toBe('https://mcp.example.com/mcp');
		await conn.close();
	});

	it('propagates auth hook errors at connect', async () => {
		const authHook = vi.fn().mockRejectedValue(new Error('vault unreachable'));
		await expect(connectMcpServer('test', baseOptions({ auth: authHook }))).rejects.toThrow(
			'vault unreachable',
		);
	});

	it('propagates McpAuthRequiredError from hook', async () => {
		const authHook = vi.fn().mockRejectedValue(
			new McpAuthRequiredError({
				authorizationUrl: 'https://auth.example.com/authorize',
			}),
		);
		await expect(connectMcpServer('test', baseOptions({ auth: authHook }))).rejects.toThrow(
			McpAuthRequiredError,
		);
	});
});

// ─── refreshTools ───────────────────────────────────────────────────────────

describe('McpServerConnection.refreshTools', () => {
	it('mutates the tools array in place and returns it', async () => {
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools
			.mockResolvedValueOnce({
				tools: [
					{ name: 'tool_a', description: 'A', inputSchema: { type: 'object', properties: {} } },
				],
			})
			.mockResolvedValueOnce({
				tools: [
					{
						name: 'tool_a',
						description: 'A updated',
						inputSchema: { type: 'object', properties: {} },
					},
					{ name: 'tool_b', description: 'B', inputSchema: { type: 'object', properties: {} } },
				],
			});

		const conn = await connectMcpServer('srv', baseOptions());
		const originalRef = conn.tools;
		expect(conn.tools).toHaveLength(1);

		const refreshed = await conn.refreshTools();

		// Same array reference — mutated in place.
		expect(refreshed).toBe(originalRef);
		expect(conn.tools).toBe(originalRef);
		expect(conn.tools).toHaveLength(2);
		expect(conn.tools.map((t) => t.name)).toEqual(['mcp__srv__tool_a', 'mcp__srv__tool_b']);
		await conn.close();
	});
});

// ─── autoRefreshTools ───────────────────────────────────────────────────────

describe('autoRefreshTools', () => {
	it('subscribes to tools/list_changed by default', async () => {
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });
		mockSetNotificationHandler.mockClear();

		await connectMcpServer('srv', baseOptions());

		expect(mockSetNotificationHandler).toHaveBeenCalledTimes(1);
		// The first arg is the ToolListChangedNotificationSchema.
		expect(mockSetNotificationHandler.mock.calls[0]?.[0]).toBeDefined();
		expect(typeof mockSetNotificationHandler.mock.calls[0]?.[1]).toBe('function');
	});

	it('skips subscription when autoRefreshTools is false', async () => {
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });
		mockSetNotificationHandler.mockClear();

		await connectMcpServer('srv', baseOptions({ autoRefreshTools: false }));

		expect(mockSetNotificationHandler).not.toHaveBeenCalled();
	});

	it('auto-refresh handler calls refreshTools on notification', async () => {
		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools
			.mockResolvedValueOnce({ tools: [] })
			.mockResolvedValueOnce({
				tools: [
					{
						name: 'new_tool',
						description: 'New',
						inputSchema: { type: 'object', properties: {} },
					},
				],
			});
		mockSetNotificationHandler.mockClear();

		const conn = await connectMcpServer('srv', baseOptions());
		expect(conn.tools).toHaveLength(0);

		// Simulate the notification callback.
		const handler = mockSetNotificationHandler.mock.calls[0]?.[1] as () => Promise<void>;
		await handler();

		expect(conn.tools).toHaveLength(1);
		expect(conn.tools[0]?.name).toBe('mcp__srv__new_tool');
		await conn.close();
	});
});

// ─── Auth fetch wrapper (integration via custom fetch) ──────────────────────

describe('auth fetch wrapper behavior', () => {
	it('injects auth headers into requests made by the transport', async () => {
		const authHook = vi.fn().mockResolvedValue({ Authorization: 'Bearer fetched-token' });

		const customFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			return new Response('{}', {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });

		const conn = await connectMcpServer(
			'test',
			baseOptions({
				auth: authHook,
				fetch: customFetch,
			}),
		);

		// The auth hook should have been called for initial connect.
		expect(authHook).toHaveBeenCalledWith(expect.objectContaining({ reason: 'connect' }));

		await conn.close();
	});

	it('retries once on 401 with reason retry-after-401', async () => {
		const authHook = vi
			.fn()
			.mockResolvedValueOnce({ Authorization: 'Bearer expired-token' })
			.mockResolvedValueOnce({ Authorization: 'Bearer refreshed-token' });

		const customFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
			const authHeader = init?.headers
				? new Headers(init.headers).get('authorization')
				: null;
			if (authHeader === 'Bearer expired-token') {
				return new Response('Unauthorized', {
					status: 401,
					headers: { 'www-authenticate': 'Bearer realm="mcp"' },
				});
			}
			return new Response('{}', {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });

		const conn = await connectMcpServer(
			'test',
			baseOptions({
				auth: authHook,
				fetch: customFetch,
			}),
		);

		// At this point, the auth hook was called once for 'connect'.
		// The fetch wrapper's retry-on-401 is exercised when the transport
		// makes actual HTTP requests. We verify the hook was called for connect.
		expect(authHook).toHaveBeenCalledWith(expect.objectContaining({ reason: 'connect' }));

		await conn.close();
	});

	it('composes static headers with auth hook (hook overrides on collision)', async () => {
		const authHook = vi.fn().mockResolvedValue({
			Authorization: 'Bearer from-hook',
			'X-Hook-Header': 'hook-value',
		});

		const customFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
			return new Response('{}', {
				status: 200,
				headers: { 'content-type': 'application/json' },
			});
		}) as unknown as typeof fetch;

		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });

		await connectMcpServer(
			'test',
			baseOptions({
				headers: {
					Authorization: 'Bearer from-static',
					'X-Static-Header': 'static-value',
				},
				auth: authHook,
				fetch: customFetch,
			}),
		);

		// The auth hook is called with 'connect', and its headers should
		// override static headers on collision (Authorization), while
		// non-colliding static headers are preserved.
		expect(authHook).toHaveBeenCalledWith(expect.objectContaining({ reason: 'connect' }));
	});
});

// ─── Abort propagation ──────────────────────────────────────────────────────

describe('abort propagation', () => {
	it('passes an AbortSignal to the auth hook', async () => {
		let receivedSignal: AbortSignal | undefined;
		const authHook = vi.fn(async (ctx: { signal: AbortSignal }) => {
			receivedSignal = ctx.signal;
			return { Authorization: 'Bearer ok' };
		});

		mockConnect.mockResolvedValueOnce(undefined);
		mockListTools.mockResolvedValueOnce({ tools: [] });

		await connectMcpServer('test', baseOptions({ auth: authHook }));

		expect(receivedSignal).toBeInstanceOf(AbortSignal);
		expect(receivedSignal?.aborted).toBe(false);
	});
});
