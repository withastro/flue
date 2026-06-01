import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolParameters } from './types.ts';

/** Remote MCP transport. */
export type McpTransport = 'streamable-http' | 'sse';

/** Options for {@link connectMcpServer}. */
export interface McpServerOptions {
	/** MCP server endpoint. */
	url: string | URL;
	/** Defaults to modern streamable HTTP. Use `'sse'` for legacy MCP servers. */
	transport?: McpTransport;
	/** Headers merged into MCP transport requests. */
	headers?: HeadersInit;
	/** Additional MCP transport request configuration. */
	requestInit?: RequestInit;
	/** Custom fetch implementation used by the MCP transport. */
	fetch?: typeof fetch;
	/** MCP client name. Defaults to `'flue'`. */
	clientName?: string;
	/** MCP client version. Defaults to `'0.0.0'`. */
	clientVersion?: string;
}

/** Connection returned by {@link connectMcpServer}. */
export interface McpServerConnection {
	/** Server name supplied to {@link connectMcpServer}. */
	name: string;
	/** MCP tools adapted into ordinary Flue tool definitions. */
	tools: ToolDefinition[];
	/** Close the underlying MCP client connection. */
	close(): Promise<void>;
}

/**
 * Connects to a remote MCP server and adapts its listed tools into ordinary
 * Flue tool definitions.
 *
 * Adapted tool names use `mcp__<server>__<tool>`. Unsupported characters are
 * replaced with underscores, and duplicate adapted names are rejected. Close
 * the returned connection when its tools are no longer needed.
 */
export async function connectMcpServer(
	name: string,
	options: McpServerOptions,
): Promise<McpServerConnection> {
	const url = options.url instanceof URL ? options.url : new URL(options.url);
	const requestInit = mergeRequestInit(options.requestInit, options.headers);
	const transport = await createTransport(
		url,
		options.transport ?? 'streamable-http',
		requestInit,
		options.fetch,
	);
	const client = new Client({
		name: options.clientName ?? 'flue',
		version: options.clientVersion ?? '0.0.0',
	});

	try {
		await client.connect(transport);
		let page = await client.listTools();
		const tools = [...page.tools];
		while (page.nextCursor !== undefined) {
			page = await client.listTools({ cursor: page.nextCursor });
			tools.push(...page.tools);
		}

		return {
			name,
			tools: createMcpTools(name, client, tools),
			close: () => client.close(),
		};
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

async function createTransport(
	url: URL,
	transport: McpTransport,
	requestInit: RequestInit,
	fetchImpl: typeof fetch | undefined,
) {
	if (transport === 'sse') {
		const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
		return new SSEClientTransport(url, {
			requestInit,
			fetch: fetchImpl,
		});
	}
	return new StreamableHTTPClientTransport(url, {
		requestInit,
		fetch: fetchImpl,
	});
}

function createMcpTools(serverName: string, client: Client, tools: Tool[]): ToolDefinition[] {
	const names = new Set<string>();

	return tools.map((tool) => {
		const toolName = createToolName(serverName, tool.name);
		if (names.has(toolName)) {
			throw new Error(
				`[flue] MCP tools from server "${serverName}" produced duplicate tool name "${toolName}".`,
			);
		}
		names.add(toolName);

		return {
			name: toolName,
			description: createToolDescription(serverName, tool),
			parameters: normalizeInputSchema(tool.inputSchema),
			async execute(args, signal) {
				if (signal?.aborted) throw new Error('Operation aborted');
				const result = await client.callTool(
					{
						name: tool.name,
						arguments: args,
					},
					undefined,
					{ signal },
				);

				const text = formatMcpResult(result as CallToolResult);
				if ((result as CallToolResult).isError) {
					throw new Error(text);
				}
				return text;
			},
		};
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
	const originalName = tool.name;
	const title = tool.title ?? tool.annotations?.title;
	const parts = [`MCP tool "${originalName}" from server "${serverName}".`];
	if (title && title !== originalName) parts.push(`Title: ${title}.`);
	if (tool.description) parts.push(tool.description);
	return parts.join(' ');
}

function normalizeInputSchema(schema: Tool['inputSchema']): ToolParameters {
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

	if (parts.length === 0 && 'toolResult' in result) {
		parts.push(JSON.stringify(result.toolResult, null, 2));
	}

	return parts.filter(Boolean).join('\n\n') || '(MCP tool returned no content)';
}
