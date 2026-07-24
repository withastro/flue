/**
 * MCP definition shapes, dependency-free so both `types.ts` (render config)
 * and `mcp.ts` (the connector) can import them.
 */

/** Remote MCP transport. */
export type McpTransport = 'streamable-http' | 'sse';

/**
 * Bearer credential for an MCP server: a static token, or a resolver the
 * runtime calls to obtain the current token — per request, so rotating and
 * per-user credentials stay fresh for a connection's whole lifetime. Keep the
 * durable key (say, a user id) in the resolver's closure and fetch the token
 * inside it; tokens are never persisted.
 */
export type McpAuth = string | (() => string | Promise<string>);

/**
 * One MCP server, as `defineMcpConnection(...)`, `useMcpConnection(...)`, and
 * `createMcpConnection(...)` consume it.
 */
export interface McpConnectionDefinition {
	/** Server name — the `mcp__<server>__` namespace of its adapted tools. */
	name: string;
	/** MCP server endpoint. */
	url: string | URL;
	/** Defaults to modern streamable HTTP. Use `'sse'` for legacy MCP servers. */
	transport?: McpTransport;
	/** Bearer credential, sent as `Authorization: Bearer <token>` on every request. */
	auth?: McpAuth;
	/**
	 * Static headers merged into MCP transport requests (set-wins over
	 * `requestInit` headers). For credentials, prefer `auth`.
	 */
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
	 * Allowlist of tools to adapt, by the server's own tool names, in this
	 * order. Names the server does not expose are an error — a typo must fail
	 * loud, not silently narrow the tool set. Omit to adapt every listed tool.
	 */
	tools?: string[];
	/**
	 * Let the agent run without this server when it fails to resolve.
	 * Default `false`: a failed connection fails the submission before the
	 * model runs. With `optional: true`, the failure mounts zero tools for
	 * the submission instead — announced to the model as a `resources`
	 * signal and to observers as a warning event — and the next submission
	 * retries.
	 */
	optional?: boolean;
}

/**
 * One optional MCP connection that failed to resolve at submission
 * initialization: the server contributed no tools, and the session announces
 * the gap to the model.
 */
export interface McpUnavailableConnection {
	/** Declared server name. */
	name: string;
	/** Failure description, from the connect or discovery error. */
	reason: string;
}
