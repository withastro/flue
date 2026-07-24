import type { McpConnectionDefinition, McpTransport } from '../mcp-types.ts';
import { requireRenderFrame } from './frame.ts';

const DEFINITION_KEYS = new Set<string>([
	'name',
	'url',
	'transport',
	'auth',
	'headers',
	'requestInit',
	'fetch',
	'timeoutMs',
	'resetTimeoutOnProgress',
	'tools',
	'optional',
]);

const TRANSPORTS: readonly McpTransport[] = ['streamable-http', 'sse'];

/**
 * Validate an MCP connection definition. Shared between
 * {@link defineMcpConnection} (module-load time) and
 * {@link useMcpConnection} (mount time) so a definition can reach the mount
 * site without passing through the helper.
 */
function assertMcpConnectionDefinition(
	definition: unknown,
	source: string,
): asserts definition is McpConnectionDefinition {
	if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
		throw new Error(`[flue] ${source} requires a definition object: { name, url, ... }.`);
	}
	const candidate = definition as Partial<McpConnectionDefinition>;
	const { name } = candidate;
	if (typeof name !== 'string' || name.trim().length === 0) {
		throw new Error(`[flue] ${source} name must be a non-empty string.`);
	}
	for (const key of Object.keys(definition)) {
		if (!DEFINITION_KEYS.has(key)) {
			throw new Error(`[flue] ${source} "${name}" received unknown field "${key}".`);
		}
	}
	const { url } = candidate;
	if (typeof url !== 'string' && !(url instanceof URL)) {
		throw new Error(`[flue] ${source} "${name}" requires \`url\`: the MCP server endpoint.`);
	}
	if (typeof url === 'string' && !URL.canParse(url)) {
		throw new Error(
			`[flue] ${source} "${name}" url ${JSON.stringify(url)} is not a valid absolute URL.`,
		);
	}
	if (candidate.transport !== undefined && !TRANSPORTS.includes(candidate.transport)) {
		throw new Error(
			`[flue] ${source} "${name}" transport must be one of ${TRANSPORTS.map((transport) => `'${transport}'`).join(', ')}.`,
		);
	}
	if (candidate.auth !== undefined) {
		const validStatic = typeof candidate.auth === 'string' && candidate.auth.length > 0;
		if (!validStatic && typeof candidate.auth !== 'function') {
			throw new Error(
				`[flue] ${source} "${name}" auth must be a bearer token or a function resolving one per request.`,
			);
		}
	}
	if (
		candidate.headers !== undefined &&
		(typeof candidate.headers !== 'object' || candidate.headers === null)
	) {
		throw new Error(
			`[flue] ${source} "${name}" headers must be a static HeadersInit value; for credentials resolved per request, use \`auth\`.`,
		);
	}
	if (
		candidate.requestInit !== undefined &&
		(typeof candidate.requestInit !== 'object' || Array.isArray(candidate.requestInit))
	) {
		throw new Error(`[flue] ${source} "${name}" requestInit must be an object.`);
	}
	if (candidate.fetch !== undefined && typeof candidate.fetch !== 'function') {
		throw new Error(`[flue] ${source} "${name}" fetch must be a function.`);
	}
	if (
		candidate.timeoutMs !== undefined &&
		(typeof candidate.timeoutMs !== 'number' ||
			!Number.isFinite(candidate.timeoutMs) ||
			candidate.timeoutMs <= 0)
	) {
		throw new Error(`[flue] ${source} "${name}" timeoutMs must be a positive number.`);
	}
	if (
		candidate.resetTimeoutOnProgress !== undefined &&
		typeof candidate.resetTimeoutOnProgress !== 'boolean'
	) {
		throw new Error(`[flue] ${source} "${name}" resetTimeoutOnProgress must be a boolean.`);
	}
	if (candidate.tools !== undefined) {
		if (
			!Array.isArray(candidate.tools) ||
			candidate.tools.some((tool) => typeof tool !== 'string' || tool.length === 0)
		) {
			throw new Error(
				`[flue] ${source} "${name}" tools must be an array of tool names (the server's own names).`,
			);
		}
	}
	if (candidate.optional !== undefined && typeof candidate.optional !== 'boolean') {
		throw new Error(`[flue] ${source} "${name}" optional must be a boolean.`);
	}
}

/**
 * Declare a reusable MCP connection. A typing helper in the `defineTool()`
 * mold: it validates the definition and returns it frozen, so bad
 * definitions fail at module load instead of first render. The returned
 * object is the exportable unit — define a server once, mount it from any
 * agent with `useMcpConnection(...)`.
 *
 * ```ts
 * export const linear = defineMcpConnection({
 *   name: 'linear',
 *   url: 'https://mcp.linear.app/mcp',
 *   auth: process.env.LINEAR_API_KEY,
 * });
 * ```
 *
 * `useMcpConnection(...)` also accepts the same object inline (same
 * validation, applied at the mount site). Per-mount overrides spread
 * cleanly: `useMcpConnection({ ...linear, tools: ['create_issue'] })`.
 */
export function defineMcpConnection(definition: McpConnectionDefinition): McpConnectionDefinition {
	assertMcpConnectionDefinition(definition, 'defineMcpConnection()');
	return Object.freeze({
		...definition,
		...(definition.tools !== undefined ? { tools: Object.freeze([...definition.tools]) } : {}),
	}) as McpConnectionDefinition;
}

/**
 * Declare a remote [MCP](https://modelcontextprotocol.io) server whose tools
 * this agent uses. The hook is a declaration — it records the definition on
 * the render and returns nothing. The runtime connects when a submission
 * initializes (inside request context, so it works on every target — never
 * connect at module scope), discovers the server's tools, and mounts them
 * into the render's tool set as `mcp__<server>__<tool>`:
 *
 * ```ts
 * export function ProjectAssistant() {
 *   useModel('anthropic/claude-sonnet-4-6');
 *   useMcpConnection({
 *     name: 'linear',
 *     url: 'https://mcp.linear.app/mcp',
 *     auth: process.env.LINEAR_API_KEY,
 *     tools: ['create_issue', 'search_issues'],
 *   });
 *   return 'Manage Linear issues and projects.';
 * }
 * ```
 *
 * Semantics:
 * - Declarations are read once per submission at initialization, and every
 *   declared server connects in parallel. A conditional declaration takes
 *   effect on the NEXT submission; the tool-set change is announced to the
 *   model as a `resources` signal like any other conditional tool.
 * - Connections are reused for the instance's in-memory lifetime —
 *   definitions are read when the connection is first established. The
 *   exception is `auth`, resolved fresh on every request: the seam for
 *   per-user or rotating credentials — keep the durable key (say, a user id
 *   from `useInitialData()`) in a resolver's closure and fetch the current
 *   token inside it; tokens never touch persistent state.
 * - A server that fails to connect fails the submission before the model
 *   runs, and the failure is not cached — the next submission retries.
 * - `tools` allowlists what to mount, by the server's own tool names; names
 *   the server does not expose are an error.
 *
 * To share one definition across agents, export it with
 * {@link defineMcpConnection} and mount the exported object. To filter or
 * wrap the adapted definitions yourself, drop down to `createMcpConnection(...)`
 * and mount the results with `useTool()` — trusted application code on the
 * Node target only (module-scope network I/O does not run on Cloudflare
 * Workers). Duplicate server names in one render fail fast. Not available in
 * subagent renders.
 */
export function useMcpConnection(definition: McpConnectionDefinition): void {
	const frame = requireRenderFrame('useMcpConnection');
	if (frame.kind === 'subagent') {
		throw new Error(
			"[flue] useMcpConnection() is not available in a subagent render. Declare the connection on the root agent and give the delegate what it needs through the parent's tools.",
		);
	}
	assertMcpConnectionDefinition(definition, 'useMcpConnection()');
	if (frame.mcpConnections.some((declared) => declared.name === definition.name)) {
		throw new Error(
			`[flue] useMcpConnection() declared the MCP server name "${definition.name}" twice in one render. Each server declares once; share it from a single custom hook.`,
		);
	}
	frame.mcpConnections.push(definition);
}
