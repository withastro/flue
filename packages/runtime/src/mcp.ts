import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ToolListChangedNotificationSchema, type CallToolResult, type Tool } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolParameters } from './types.ts';

// ─── Auth types ─────────────────────────────────────────────────────────────

/**
 * Re-export of the MCP SDK's `OAuthClientProvider` interface. Pass an
 * implementation to `McpServerOptions.authProvider` for full OAuth 2.1 flows
 * (PKCE, dynamic client registration, token refresh). The SDK transports
 * handle the 401/refresh/redirect dance; Flue just forwards the provider.
 */
export type McpOAuthClientProvider = OAuthClientProvider;

/** Why the auth hook is being called. */
export type McpAuthReason = 'connect' | 'retry-after-401' | 'revalidate';

/** Context passed to the auth hook on every invocation. */
export interface McpAuthContext {
	/** The MCP server URL this connection targets. */
	serverUrl: URL;
	/** Why the hook is being called. */
	reason: McpAuthReason;
	/** Aborted when the agent run is torn down. */
	signal: AbortSignal;
	/**
	 * The `WWW-Authenticate` header from the 401 response, when
	 * `reason === 'retry-after-401'`. Contains `resource_metadata` and other
	 * parameters needed to drive RFC 9728 discovery.
	 */
	wwwAuthenticate?: string;
}

/**
 * Dynamic auth hook. Return headers (e.g. `{ Authorization: 'Bearer ...' }`)
 * that will be merged into every outbound MCP request. Called once at connect
 * time and again on 401 retry. The returned promise may perform async work
 * such as fetching a token from a vault.
 *
 * For interactive OAuth flows, throw {@link McpAuthRequiredError} with the
 * authorization URL. The wrapping workflow can then dispatch the URL to a
 * user-facing channel and resume once the callback arrives.
 */
export type McpAuthHook = (ctx: McpAuthContext) => HeadersInit | Promise<HeadersInit>;

/**
 * Thrown from an {@link McpAuthHook} to signal that interactive authorization
 * is required. The workflow layer should catch this, present the authorization
 * URL to the user (via an external channel / dispatch), and retry once
 * credentials have been persisted.
 */
export class McpAuthRequiredError extends Error {
	override readonly name = 'McpAuthRequiredError';
	readonly authorizationUrl?: URL;
	readonly resourceMetadataUrl?: URL;
	readonly wwwAuthenticate?: string;

	constructor(init: {
		message?: string;
		authorizationUrl?: URL | string;
		resourceMetadataUrl?: URL | string;
		wwwAuthenticate?: string;
		cause?: unknown;
	}) {
		super(init.message ?? 'MCP server requires interactive authorization', { cause: init.cause });
		this.authorizationUrl = init.authorizationUrl
			? init.authorizationUrl instanceof URL ? init.authorizationUrl : new URL(init.authorizationUrl)
			: undefined;
		this.resourceMetadataUrl = init.resourceMetadataUrl
			? init.resourceMetadataUrl instanceof URL ? init.resourceMetadataUrl : new URL(init.resourceMetadataUrl)
			: undefined;
		this.wwwAuthenticate = init.wwwAuthenticate;
	}
}

// ─── Connection types ───────────────────────────────────────────────────────

export type McpTransport = 'streamable-http' | 'sse';

export interface McpServerOptions {
	url: string | URL;
	/** Defaults to modern streamable HTTP. Use 'sse' for legacy MCP servers. */
	transport?: McpTransport;
	/** Static headers merged into every outbound request. Composes with `auth`. */
	headers?: HeadersInit;
	requestInit?: RequestInit;
	fetch?: typeof fetch;
	clientName?: string;
	clientVersion?: string;

	/**
	 * Dynamic auth hook. Called at connect time and on 401 retry. Returns
	 * headers that override static `headers` on key collisions.
	 *
	 * Mutually exclusive with `authProvider`.
	 */
	auth?: McpAuthHook;

	/**
	 * Pre-emptive refresh interval in milliseconds. When set, the cached auth
	 * headers are refreshed via the `auth` hook after this duration, before a
	 * 401 is received. Only meaningful when `auth` is provided. Off by default.
	 */
	revalidate?: number;

	/**
	 * Full MCP-SDK OAuth client provider. Handed directly to the transport for
	 * spec-compliant OAuth 2.1 flows (PKCE, dynamic client registration,
	 * token refresh, 401 retry).
	 *
	 * Mutually exclusive with `auth`.
	 */
	authProvider?: McpOAuthClientProvider;

	/**
	 * When `true` (the default), the connection subscribes to the MCP
	 * `notifications/tools/list_changed` event and automatically calls
	 * {@link McpServerConnection.refreshTools} when the server signals a
	 * tool-list change. Set to `false` to manage tool refreshes manually.
	 */
	autoRefreshTools?: boolean;
}

export interface McpServerConnection {
	name: string;
	tools: ToolDefinition[];
	/**
	 * Re-run `listTools()` against the server, mutate the `tools` array in
	 * place, and return the updated list. Existing sessions that were opened
	 * before the refresh still see their original tool snapshot; only sessions
	 * opened after the refresh pick up the changes.
	 */
	refreshTools(): Promise<ToolDefinition[]>;
	close(): Promise<void>;
}

export async function connectMcpServer(
	name: string,
	options: McpServerOptions,
): Promise<McpServerConnection> {
	if (options.auth && options.authProvider) {
		throw new Error(
			'[flue] McpServerOptions: `auth` and `authProvider` are mutually exclusive. ' +
				'Use `auth` for a lightweight header hook or `authProvider` for full MCP-SDK OAuth.',
		);
	}
	if (options.authProvider) {
		throw new Error(
			'[flue] McpServerOptions.authProvider is not yet implemented. ' +
				'It will be available in a future release. For now, use `auth` or `fetch` / `requestInit` ' +
				'to inject custom auth logic.',
		);
	}

	const url = options.url instanceof URL ? options.url : new URL(options.url);
	const baseRequestInit = mergeRequestInit(options.requestInit, options.headers);

	// Build the fetch function — either plain or wrapped with the auth hook.
	const fetchImpl = options.auth
		? createAuthFetch(options.auth, url, baseRequestInit, options.fetch, options.revalidate)
		: options.fetch;

	// When using the auth hook, perform the initial auth call before creating
	// the transport so any connect-time failures surface early.
	let initialAuthHeaders: Headers | undefined;
	if (options.auth) {
		const controller = new AbortController();
		const raw = await options.auth({
			serverUrl: url,
			reason: 'connect',
			signal: controller.signal,
		});
		initialAuthHeaders = new Headers(raw);
	}

	const transportRequestInit = initialAuthHeaders
		? mergeRequestInit(baseRequestInit, initialAuthHeaders)
		: baseRequestInit;

	const transport = await createTransport(
		url,
		options.transport ?? 'streamable-http',
		transportRequestInit,
		fetchImpl,
		options.authProvider,
	);
	const client = new Client({
		name: options.clientName ?? 'flue',
		version: options.clientVersion ?? '0.0.0',
	});

	try {
		await client.connect(transport);
		const { tools: rawTools } = await client.listTools();
		const tools = createMcpTools(name, client, rawTools);

		const connection: McpServerConnection = {
			name,
			tools,
			async refreshTools() {
				const { tools: updated } = await client.listTools();
				const refreshed = createMcpTools(name, client, updated);
				tools.length = 0;
				tools.push(...refreshed);
				return tools;
			},
			close: () => client.close(),
		};

		// Subscribe to tools/list_changed notifications (default: on).
		if (options.autoRefreshTools !== false) {
			client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
				await connection.refreshTools();
			});
		}

		return connection;
	} catch (error) {
		await client.close().catch(() => undefined);
		throw error;
	}
}

// ─── Auth fetch wrapper ─────────────────────────────────────────────────────

/**
 * Wraps `fetch` to inject auth headers from the hook, retry once on 401,
 * and optionally revalidate on a TTL.
 */
function createAuthFetch(
	auth: McpAuthHook,
	serverUrl: URL,
	baseRequestInit: RequestInit,
	baseFetch: typeof fetch | undefined,
	revalidateMs: number | undefined,
): typeof fetch {
	const doFetch = baseFetch ?? globalThis.fetch;

	// Cached auth headers + timestamp.
	let cachedHeaders: Headers | undefined;
	let cachedAt = 0;

	// In-flight refresh promise for thundering-herd dedup.
	let inflightRefresh: Promise<Headers> | undefined;

	async function refreshAuth(
		reason: McpAuthReason,
		signal: AbortSignal,
		wwwAuthenticate?: string,
	): Promise<Headers> {
		const raw = await auth({ serverUrl, reason, signal, wwwAuthenticate });
		cachedHeaders = new Headers(raw);
		cachedAt = Date.now();
		return cachedHeaders;
	}

	async function getHeaders(
		reason: McpAuthReason,
		signal: AbortSignal,
		wwwAuthenticate?: string,
	): Promise<Headers> {
		// Dedup concurrent refreshes.
		if (inflightRefresh && reason !== 'retry-after-401') {
			return inflightRefresh;
		}
		const promise = refreshAuth(reason, signal, wwwAuthenticate);
		inflightRefresh = promise;
		try {
			return await promise;
		} finally {
			if (inflightRefresh === promise) inflightRefresh = undefined;
		}
	}

	return async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const signal = init?.signal ?? new AbortController().signal;

		// Determine if we need to refresh.
		let authHeaders: Headers;
		if (!cachedHeaders || (revalidateMs && Date.now() - cachedAt >= revalidateMs)) {
			const reason: McpAuthReason = cachedHeaders ? 'revalidate' : 'connect';
			authHeaders = await getHeaders(reason, signal);
		} else {
			authHeaders = cachedHeaders;
		}

		// Merge: base static -> auth hook -> per-request init.
		const merged = mergeHeaders(baseRequestInit.headers, authHeaders, init?.headers);
		const response = await doFetch(input, { ...init, headers: merged });

		// Retry once on 401.
		if (response.status === 401) {
			const wwwAuthenticate = response.headers.get('www-authenticate') ?? undefined;
			// Consume the body to free the connection.
			await response.body?.cancel().catch(() => {});

			authHeaders = await getHeaders('retry-after-401', signal, wwwAuthenticate);
			const retryMerged = mergeHeaders(baseRequestInit.headers, authHeaders, init?.headers);
			return doFetch(input, { ...init, headers: retryMerged });
		}

		return response;
	};
}

/** Merge multiple header sources, later sources override earlier on collision. */
function mergeHeaders(...sources: (HeadersInit | undefined | null)[]): Headers {
	const merged = new Headers();
	for (const source of sources) {
		if (!source) continue;
		for (const [key, value] of new Headers(source)) {
			merged.set(key, value);
		}
	}
	return merged;
}

async function createTransport(
	url: URL,
	transport: McpTransport,
	requestInit: RequestInit,
	fetchImpl: typeof fetch | undefined,
	authProvider: McpOAuthClientProvider | undefined,
) {
	if (transport === 'sse') {
		const { SSEClientTransport } = await import('@modelcontextprotocol/sdk/client/sse.js');
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

function mergeRequestInit(requestInit: RequestInit | undefined, headers: HeadersInit | undefined): RequestInit {
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
