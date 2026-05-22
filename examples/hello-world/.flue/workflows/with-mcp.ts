import { connectMcpServer, createAgent, http, type FlueContext } from '@flue/runtime';

export const channels = [http()];

/**
 * MCP tools with static auth.
 *
 * Connects to a remote MCP server with a fixed bearer token from env,
 * passes its tools to the agent, and runs a prompt that can call them.
 *
 * Requires MCP_SERVER_URL and MCP_TOKEN in the environment.
 */
export async function run({ init, payload, env }: FlueContext) {
	const server = await connectMcpServer('remote', {
		url: env.MCP_SERVER_URL,
		headers: { Authorization: `Bearer ${env.MCP_TOKEN}` },
	});

	try {
		const agent = createAgent(() => ({
			model: 'anthropic/claude-sonnet-4-6',
			tools: server.tools,
		}));
		const harness = await init(agent);
		const session = await harness.session();

		console.log(`[with-mcp] connected, ${server.tools.length} tools available`);

		const response = await session.prompt(
			payload?.prompt ?? 'List the available tools and describe what each one does.',
		);

		console.log('[with-mcp] response:', response.text.slice(0, 200));
		return { text: response.text, toolCount: server.tools.length };
	} finally {
		await server.close();
	}
}
