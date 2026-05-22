import { connectMcpServer, createAgent, http, type FlueContext } from '@flue/runtime';

export const channels = [http()];

/**
 * MCP tools with dynamic auth hook.
 *
 * Demonstrates:
 * - Dynamic token fetching via the `auth` hook
 * - Automatic 401 retry (the hook is re-called with reason 'retry-after-401')
 * - Pre-emptive revalidation before token expiry
 * - Static headers composing with hook headers (hook overrides on collision)
 *
 * Requires MCP_SERVER_URL and MCP_TOKEN in the environment.
 * In a real setup, the token would come from a vault, KV store, or token endpoint.
 *
 * For interactive OAuth flows requiring user authorization, use the
 * agent-resident MCP pattern on Cloudflare (ctx.agent.mcp) instead of
 * the workflow auth hook.
 */
export async function run({ init, payload, env }: FlueContext) {
	let tokenVersion = 0;

	const server = await connectMcpServer('protected', {
		url: env.MCP_SERVER_URL,

		// Static headers are always sent; the auth hook's headers override on collision.
		headers: { 'X-Client': 'flue-example' },

		auth: async ({ reason, wwwAuthenticate }) => {
			console.log(`[with-mcp-auth] auth hook called: reason=${reason}`);

			// In a real workflow, you'd fetch from KV, Vault, or a token endpoint.
			// This example simulates a rotating token.
			if (reason === 'retry-after-401') {
				console.log('[with-mcp-auth] token rejected, fetching fresh one');
				console.log('[with-mcp-auth] www-authenticate:', wwwAuthenticate);
				tokenVersion++;
			}

			const token = env.MCP_TOKEN ?? `simulated-token-v${tokenVersion}`;
			return { Authorization: `Bearer ${token}` };
		},

		// Refresh cached auth headers every 50 minutes (before a typical 1h expiry).
		revalidate: 50 * 60 * 1000,
	});

	try {
		const agent = createAgent(() => ({
			model: 'anthropic/claude-sonnet-4-6',
			tools: server.tools,
		}));
		const harness = await init(agent);
		const session = await harness.session();

		console.log(`[with-mcp-auth] connected, ${server.tools.length} tools available`);

		const response = await session.prompt(
			payload?.prompt ?? 'List the available tools and describe what each one does.',
		);

		console.log('[with-mcp-auth] response:', response.text.slice(0, 200));
		return { text: response.text, toolCount: server.tools.length };
	} finally {
		await server.close();
	}
}
