import { createAgent, createMcpToolProxy, http, type FlueContext } from '@flue/runtime';

export const channels = [http()];

/**
 * Workflow consuming MCP tools from a remote agent via proxy.
 *
 * Demonstrates the proxy pattern:
 * 1. The workflow fetches MCP server state from an external source
 *    (in production, this would be an RPC call to an agent DO or
 *    identity DO that owns the MCP connections).
 * 2. createMcpToolProxy builds ToolDefinition[] from the state.
 * 3. The workflow runs an autonomous agent with the proxied tools.
 *
 * This pattern decouples MCP connection lifecycle (OAuth, tokens,
 * transport) from the workflow's execution. The workflow never manages
 * MCP connections directly — it just consumes the tools.
 */
export async function run({ init, payload }: FlueContext) {
	// In production, you'd call an agent DO or identity DO via RPC:
	//
	//   const stub = await getAgentByName(env.IDENTITY_DO, userId);
	//   const state = await stub.getMcpServersState();
	//   const callTool = (sid, name, args) => stub.callMcpTool(sid, name, args);
	//
	// For this example, we simulate a remote state snapshot.
	const state = {
		servers: {
			'github-001': {
				name: 'github',
				server_url: 'https://mcp.github.com/mcp',
				auth_url: null,
				state: 'ready' as const,
				error: null,
			},
		},
		tools: [
			{
				serverId: 'github-001',
				name: 'get_repository',
				description: 'Get information about a GitHub repository.',
				inputSchema: {
					type: 'object',
					properties: {
						owner: { type: 'string', description: 'Repository owner' },
						repo: { type: 'string', description: 'Repository name' },
					},
					required: ['owner', 'repo'],
				},
			},
		],
	};

	const tools = createMcpToolProxy({
		state,
		callTool: async (_serverId, name, args) => {
			// Simulated RPC response. In production, delegate to the identity DO.
			console.log(`[with-mcp-proxy] callTool: ${name}`, args);
			return {
				content: [{ type: 'text', text: `Simulated response for ${name}(${JSON.stringify(args)})` }],
			};
		},
	});

	console.log(`[with-mcp-proxy] ${tools.length} proxied tools available`);

	const agent = createAgent(() => ({
		model: 'anthropic/claude-sonnet-4-6',
		tools,
	}));
	const harness = await init(agent);
	const session = await harness.session();

	const response = await session.prompt(
		payload?.prompt ?? 'What tools do you have? Describe them.',
	);

	console.log('[with-mcp-proxy] response:', response.text.slice(0, 200));
	return { text: response.text, toolCount: tools.length };
}
