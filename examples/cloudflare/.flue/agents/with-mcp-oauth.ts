import { createAgent, createMcpToolProxy, http } from '@flue/runtime';

export const channels = [http()];

/**
 * Agent with durable MCP connections and interactive OAuth.
 *
 * Demonstrates:
 * - ctx.agent.mcp for managing MCP servers on the agent's Durable Object
 * - Durable state: connections, OAuth tokens, and server state persist
 *   across dispatches via DO SQLite
 * - OAuth callback auto-handled by the Agents SDK on this agent's DO
 * - createMcpToolProxy to build tool definitions from the MCP state
 *
 * First dispatch: adds the MCP server (may trigger OAuth), returns
 * available tools or instructions to authorize.
 * Subsequent dispatches: if OAuth completed, tools are available.
 *
 * Requires MCP_SERVER_URL in the environment. The MCP server at that URL
 * should support OAuth 2.1 for the full flow, or static auth via headers.
 */
export default createAgent(async (ctx) => {
	const mcp = ctx.agent?.mcp;
	if (!mcp) {
		// Graceful fallback for non-Cloudflare or workflow contexts.
		return { model: 'anthropic/claude-sonnet-4-6' };
	}

	// Add the server — idempotent across dispatches. If the server requires
	// OAuth, the Agents SDK initiates the flow; the user will see an auth URL.
	await mcp.addServer({ url: ctx.env.MCP_SERVER_URL });

	const state = mcp.getState();

	// Build tools only from 'ready' servers — mid-OAuth servers are excluded.
	const tools = createMcpToolProxy({
		state,
		callTool: async (serverId, name, args) => {
			// In a full identity-DO pattern, this would be an RPC call.
			// Here we call directly since the MCP manager is on this agent.
			const result = await mcp.callTool(serverId, name, args);
			return result;
		},
	});

	// Log server states for observability.
	for (const [id, server] of Object.entries(state.servers)) {
		console.log(`[with-mcp-oauth] server ${id}: ${server.state}`);
		if (server.auth_url) {
			console.log(`[with-mcp-oauth]   authorize at: ${server.auth_url}`);
		}
	}

	return {
		model: 'anthropic/claude-sonnet-4-6',
		instructions: tools.length > 0
			? `You have ${tools.length} MCP tools available. Use them to help the user.`
			: 'MCP tools are not yet available. If a server is authenticating, ask the user to complete authorization using the URL in the logs.',
		tools,
	};
});
