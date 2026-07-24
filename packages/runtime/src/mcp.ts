import {
	type AuthProvider,
	type CallToolResult,
	Client,
	SSEClientTransport,
	StreamableHTTPClientTransport,
	type Tool,
	type Transport,
} from '@modelcontextprotocol/client';
import { version as runtimeVersion } from '../package.json' with { type: 'json' };
import type { McpAuth, McpConnectionDefinition, McpTransport } from './mcp-types.ts';
import { registerPreparedToolAdapter } from './tool-adapter.ts';
import type { ToolDefinition } from './types.ts';

export type { McpAuth, McpConnectionDefinition, McpTransport } from './mcp-types.ts';

/** Request options in the MCP SDK's shape (its `timeout` is milliseconds). */
type McpRequestOptions = {
	timeout?: number;
	resetTimeoutOnProgress?: boolean;
};

/** Connection returned by {@link createMcpConnection}. */
export interface McpConnection {
	/** Server name supplied to {@link createMcpConnection}. */
	name: string;
	/** MCP tools adapted into ordinary Flue tool definitions. */
	tools: ToolDefinition[];
	/** Close the underlying MCP client connection. */
	close(): Promise<void>;
}

/**
 * Resolves `useMcpConnection()` declarations to live connections.
 * Coordinators inject a per-instance caching resolver; a context without one
 * connects fresh at every harness initialization.
 */
export interface McpConnectionResolver {
	resolve(definition: McpConnectionDefinition): Promise<McpConnection>;
}

/** A caching {@link McpConnectionResolver} with a teardown for coordinator shutdown. */
export interface McpConnectionCache extends McpConnectionResolver {
	/** Close every cached connection and forget them all. */
	close(): Promise<void>;
}

/**
 * A per-instance MCP connection cache: the first declaration of a server
 * name connects; later submissions reuse the live connection for the
 * instance's in-memory lifetime, so definitions are read at first connect
 * (an `auth` resolver stays per-request). Concurrent resolves of one name
 * share a single in-flight connect. A failed connect is evicted immediately —
 * a transient outage must not brick the instance, so the next submission
 * retries with a freshly read definition.
 */
export function createMcpConnectionCache(): McpConnectionCache {
	const connections = new Map<string, Promise<McpConnection>>();
	return {
		resolve(definition: McpConnectionDefinition): Promise<McpConnection> {
			const cached = connections.get(definition.name);
			if (cached) return cached;
			const pending = createMcpConnection(definition);
			connections.set(definition.name, pending);
			pending.catch(() => {
				if (connections.get(definition.name) === pending) {
					connections.delete(definition.name);
				}
			});
			return pending;
		},
		async close(): Promise<void> {
			const pending = [...connections.values()];
			connections.clear();
			await Promise.allSettled(pending.map(async (connection) => (await connection).close()));
		},
	};
}

type McpClient = Pick<Client, 'callTool' | 'close' | 'connect' | 'listTools'>;

/**
 * Connects to a remote MCP server described by a
 * {@link McpConnectionDefinition} and adapts its listed tools into ordinary
 * Flue tool definitions.
 *
 * Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are
 * replaced with underscores, and duplicate adapted names are rejected. Close
 * the returned connection when its tools are no longer needed.
 */
export async function createMcpConnection(
	definition: McpConnectionDefinition,
): Promise<McpConnection> {
	const url = definition.url instanceof URL ? definition.url : new URL(definition.url);
	const requestInit = mergeRequestInit(definition.requestInit, definition.headers);
	const transport = createTransport(
		url,
		definition.transport ?? 'streamable-http',
		requestInit,
		definition.fetch,
		definition.auth === undefined ? undefined : createAuthProvider(definition.auth),
	);
	const client = new Client({
		name: 'flue',
		version: runtimeVersion,
	});

	return createMcpConnectionWithClient(
		definition.name,
		client,
		transport,
		{
			timeout: definition.timeoutMs,
			resetTimeoutOnProgress: definition.resetTimeoutOnProgress,
		},
		{ tools: definition.tools },
	);
}

export async function createMcpConnectionWithClient(
	name: string,
	client: McpClient,
	transport: Transport,
	requestOptions: McpRequestOptions = {},
	selection: { tools?: readonly string[] } = {},
): Promise<McpConnection> {
	try {
		await client.connect(transport);
		let page = await client.listTools(undefined, requestOptions);
		const tools = [...page.tools];
		const seenCursors = new Set<string>();
		while (page.nextCursor !== undefined) {
			if (seenCursors.has(page.nextCursor)) {
				throw new Error(
					`[flue] MCP server "${name}" repeated tools/list cursor ${JSON.stringify(page.nextCursor)} during tool discovery.`,
				);
			}
			seenCursors.add(page.nextCursor);
			page = await client.listTools({ cursor: page.nextCursor }, requestOptions);
			tools.push(...page.tools);
		}

		return {
			name,
			tools: createMcpTools(
				name,
				client,
				selectMcpTools(name, tools, selection.tools),
				requestOptions,
			),
			close: () => client.close(),
		};
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

/**
 * Adapt the `auth` credential to the MCP SDK's {@link AuthProvider}: the
 * transport calls `token()` before every request, and on a 401 awaits
 * `onUnauthorized` and retries once — re-resolving the token, so the
 * application's credential store is the refresh policy.
 */
function createAuthProvider(auth: McpAuth): AuthProvider {
	const resolveToken = typeof auth === 'function' ? auth : () => auth;
	return {
		token: async () => resolveToken(),
		onUnauthorized: async () => {},
	};
}

/**
 * Apply the `tools` allowlist to the discovered listing, in allowlist order.
 * Every allowlisted name must exist and be callable — a typo or an
 * unsupported tool must fail loud, not silently narrow the tool set.
 */
function selectMcpTools(
	serverName: string,
	discovered: Tool[],
	allowlist: readonly string[] | undefined,
): Tool[] {
	if (allowlist === undefined) return discovered;
	const byName = new Map(discovered.map((tool) => [tool.name, tool]));
	const duplicates = allowlist.filter((name, index) => allowlist.indexOf(name) !== index);
	if (duplicates.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" tools allowlist repeats ${formatToolNames(duplicates)}.`,
		);
	}
	const unknown = allowlist.filter((name) => !byName.has(name));
	if (unknown.length > 0) {
		throw new Error(
			`[flue] MCP server "${serverName}" does not expose ${formatToolNames(unknown)} named in the tools allowlist. Discovered tools: ${
				discovered.map((tool) => tool.name).join(', ') || '(none)'
			}.`,
		);
	}
	return allowlist.map((name) => {
		const tool = byName.get(name) as Tool;
		if (tool.execution?.taskSupport === 'required') {
			throw new Error(
				`[flue] MCP tool "${name}" from server "${serverName}" requires task-based execution, which is not supported — remove it from the tools allowlist.`,
			);
		}
		return tool;
	});
}

function formatToolNames(names: readonly string[]): string {
	return [...new Set(names)].map((name) => JSON.stringify(name)).join(', ');
}

function createTransport(
	url: URL,
	transport: McpTransport,
	requestInit: RequestInit,
	fetchImpl: typeof fetch | undefined,
	authProvider: AuthProvider | undefined,
) {
	if (transport === 'sse') {
		return new SSEClientTransport(url, {
			requestInit,
			fetch: fetchImpl,
			authProvider,
		});
	}
	return new StreamableHTTPClientTransport(url, {
		requestInit,
		fetch: fetchImpl,
		authProvider,
	});
}

function createMcpTools(
	serverName: string,
	client: McpClient,
	tools: Tool[],
	requestOptions: McpRequestOptions,
): ToolDefinition[] {
	const names = new Set<string>();

	const callableTools = tools.filter((tool) => {
		if (tool.execution?.taskSupport !== 'required') return true;
		console.warn(
			`[flue] Skipping MCP tool "${tool.name}" from server "${serverName}": it requires task-based execution, which is not supported.`,
		);
		return false;
	});

	return callableTools.map((tool) => {
		const toolName = createToolName(serverName, tool.name);
		if (names.has(toolName)) {
			throw new Error(
				`[flue] MCP tools from server "${serverName}" produced duplicate tool name "${toolName}".`,
			);
		}
		names.add(toolName);

		const definition: ToolDefinition = {
			name: toolName,
			description: createToolDescription(serverName, tool),
			input: undefined,
			output: undefined,
			run() {
				throw new Error('[flue] MCP tools execute through the internal adapter.');
			},
		};
		registerPreparedToolAdapter(definition, {
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(args, signal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				// The client validates structured output against the tool's
				// declared output schema itself and surfaces a mismatch as an
				// error — nothing to re-check here.
				const result: CallToolResult = await client.callTool(
					{
						name: tool.name,
						arguments: args,
					},
					{ ...requestOptions, signal },
				);
				const text = formatMcpResult(result);
				if (result.isError) {
					throw new Error(text);
				}
				return text;
			},
		});
		return Object.freeze(definition);
	});
}

function mergeRequestInit(
	requestInit: RequestInit | undefined,
	headers: HeadersInit | undefined,
): RequestInit {
	if (!headers) return requestInit ?? {};
	const mergedHeaders = new Headers(requestInit?.headers);
	for (const [key, value] of new Headers(headers)) {
		mergedHeaders.set(key, value);
	}
	return {
		...requestInit,
		headers: mergedHeaders,
	};
}

function createToolName(serverName: string, toolName: string): string {
	return `mcp__${sanitizeToolNamePart(serverName)}__${sanitizeToolNamePart(toolName)}`;
}

function sanitizeToolNamePart(value: string): string {
	const sanitized = value.replace(/[^A-Za-z0-9_-]/g, '_').replace(/^_+|_+$/g, '');
	return sanitized || 'unnamed';
}

function createToolDescription(serverName: string, tool: Tool): string {
	const parts: string[] = [];
	// The adapted name parses back to the original ("mcp__linear__create_issue")
	// unless sanitization altered a part — only then does the mapping need
	// spelling out, so server descriptions that cross-reference sibling tools
	// by their original names stay followable.
	const sanitized =
		sanitizeToolNamePart(serverName) !== serverName ||
		sanitizeToolNamePart(tool.name) !== tool.name;
	if (sanitized) parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	const title = tool.title ?? tool.annotations?.title;
	if (title && title !== tool.name) parts.push(`Title: ${title}.`);
	if (tool.description) parts.push(tool.description);
	if (parts.length === 0) parts.push(`MCP tool "${tool.name}" from server "${serverName}".`);
	return parts.join(' ');
}

function normalizeInputSchema(schema: Tool['inputSchema']): object {
	return {
		...schema,
		type: schema.type ?? 'object',
		properties: schema.properties ?? {},
		required: schema.required,
	};
}

function formatMcpResult(result: CallToolResult): string {
	const parts: string[] = [];

	if (result.structuredContent !== undefined) {
		parts.push(`Structured content:\n${JSON.stringify(result.structuredContent, null, 2)}`);
	}

	for (const item of result.content ?? []) {
		if (item.type === 'text') {
			parts.push(item.text);
			continue;
		}
		if (item.type === 'image') {
			parts.push(`[Image: ${item.mimeType}, ${item.data.length} base64 chars]`);
			continue;
		}
		if (item.type === 'audio') {
			parts.push(`[Audio: ${item.mimeType}, ${item.data.length} base64 chars]`);
			continue;
		}
		if (item.type === 'resource') {
			const resource = item.resource;
			if ('text' in resource) {
				parts.push(`[Resource: ${resource.uri}]\n${resource.text}`);
			} else {
				parts.push(`[Resource: ${resource.uri}, ${resource.blob.length} base64 chars]`);
			}
			continue;
		}
		if (item.type === 'resource_link') {
			const description = item.description ? ` - ${item.description}` : '';
			parts.push(`[Resource link: ${item.name} (${item.uri})${description}]`);
			continue;
		}
		parts.push(JSON.stringify(item));
	}

	return parts.filter(Boolean).join('\n\n') || '(MCP tool returned no content)';
}
