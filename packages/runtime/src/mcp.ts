import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	type CallToolResult,
	ErrorCode,
	McpError,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import type {
	JsonSchemaValidator,
	jsonSchemaValidator as JsonSchemaValidatorProvider,
} from '@modelcontextprotocol/sdk/validation';
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker';
import { version as runtimeVersion } from '../package.json' with { type: 'json' };
import { registerPreparedToolAdapter } from './tool-adapter.ts';
import type { ToolDefinition } from './types.ts';

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
	/** Per-request timeout in milliseconds for MCP requests. Defaults to the MCP SDK default (60 seconds). */
	timeoutMs?: number;
	/** Reset the per-request timeout whenever the server sends a progress notification. Defaults to `false`. */
	resetTimeoutOnProgress?: boolean;
	/**
	 * JSON Schema validator used to validate MCP tool `outputSchema`s.
	 *
	 * Defaults to {@link CfWorkerJsonSchemaValidator}, which interprets JSON
	 * Schema at runtime with no code generation. The MCP SDK's default
	 * `AjvJsonSchemaValidator` compiles schemas via `new Function`, which throws
	 * `EvalError: Code generation from strings disallowed` on edge runtimes such
	 * as Cloudflare Workers (workerd). The default keeps `connectMcpServer`
	 * working everywhere; pass a custom validator (e.g. `AjvJsonSchemaValidator`)
	 * to opt into AJV on Node.js.
	 */
	jsonSchemaValidator?: JsonSchemaValidatorProvider;
}

/** Request options in the MCP SDK's shape (its `timeout` is milliseconds). */
type McpRequestOptions = {
	timeout?: number;
	resetTimeoutOnProgress?: boolean;
};

/** Connection returned by {@link connectMcpServer}. */
export interface McpServerConnection {
	/** Server name supplied to {@link connectMcpServer}. */
	name: string;
	/** MCP tools adapted into ordinary Flue tool definitions. */
	tools: ToolDefinition[];
	/** Close the underlying MCP client connection. */
	close(): Promise<void>;
}

type McpClient = Pick<Client, 'callTool' | 'close' | 'connect' | 'listTools'>;

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
	const jsonSchemaValidator = options.jsonSchemaValidator ?? new CfWorkerJsonSchemaValidator();
	const client = new Client(
		{
			name: 'flue',
			version: runtimeVersion,
		},
		{ jsonSchemaValidator },
	);

	return connectMcpServerWithClient(
		name,
		client,
		transport,
		{
			timeout: options.timeoutMs,
			resetTimeoutOnProgress: options.resetTimeoutOnProgress,
		},
		jsonSchemaValidator,
	);
}

export async function connectMcpServerWithClient(
	name: string,
	client: McpClient,
	transport: Transport,
	requestOptions: McpRequestOptions = {},
	jsonSchemaValidator: JsonSchemaValidatorProvider = new CfWorkerJsonSchemaValidator(),
): Promise<McpServerConnection> {
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
			tools: createMcpTools(name, client, tools, requestOptions, jsonSchemaValidator),
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

function createMcpTools(
	serverName: string,
	client: McpClient,
	tools: Tool[],
	requestOptions: McpRequestOptions,
	validator: JsonSchemaValidatorProvider,
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
		const outputValidator = tool.outputSchema
			? validator.getValidator(tool.outputSchema)
			: undefined;
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
				const result = (await client.callTool(
					{
						name: tool.name,
						arguments: args,
					},
					undefined,
					{ ...requestOptions, signal },
				)) as CallToolResult;

				validateMcpResult(tool.name, result, outputValidator);
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

function validateMcpResult(
	toolName: string,
	result: CallToolResult,
	validator: JsonSchemaValidator<unknown> | undefined,
): void {
	if (!validator) return;
	if (result.structuredContent === undefined && !result.isError) {
		throw new McpError(
			ErrorCode.InvalidRequest,
			`Tool ${toolName} has an output schema but did not return structured content`,
		);
	}
	if (result.structuredContent === undefined) return;
	const validation = validator(result.structuredContent);
	if (!validation.valid) {
		throw new McpError(
			ErrorCode.InvalidParams,
			`Structured content does not match the tool's output schema: ${validation.errorMessage}`,
		);
	}
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
