/**
 * Cloudflare-specific facade over the Agents SDK's MCPClientManager.
 *
 * This module is imported only by the generated Cloudflare entry point, never
 * by user code directly. It bridges the SDK's MCPClientManager (available on
 * `doInstance.mcp`) into Flue's `FlueAgentMcp` interface.
 */
import type { FlueAgentMcp, FlueAgentMcpServerOptions, FlueAgentMcpState } from '../types.ts';

/**
 * Structural type for the subset of MCPClientManager we use. Avoids importing
 * the `agents` package at the type level in the runtime — that import is only
 * available on Cloudflare.
 */
export interface McpClientManagerLike {
	addServer(url: string, options?: Record<string, unknown>): Promise<string>;
	removeServer(id: string): Promise<void>;
	getMcpServers(): {
		servers: Record<string, {
			name: string;
			server_url: string;
			auth_url: string | null;
			state: string;
			error: string | null;
			instructions: string | null;
			capabilities: unknown;
		}>;
		tools: Array<{
			serverId: string;
			name: string;
			description?: string;
			inputSchema: Record<string, unknown>;
		}>;
		prompts: unknown[];
		resources: unknown[];
	};
	configureOAuthCallback(opts: {
		customHandler: (result: { authSuccess?: boolean; authError?: string; request: Request }) => Response | Promise<Response>;
	}): void;
}

const DEFAULT_SUCCESS_HTML = `<!doctype html>
<html><body style="font-family: system-ui; padding: 2rem; text-align: center;">
<h1>Authorization complete</h1>
<p>You can close this window and return to your agent.</p>
</body></html>`;

/**
 * Configure the MCP OAuth callback handler on the agent DO.
 * Called once per DO cold-wake from the generated constructor.
 */
export function configureMcpOAuthCallback(
	mcp: McpClientManagerLike,
	enabled: boolean,
): void {
	if (!enabled) return;

	mcp.configureOAuthCallback({
		customHandler: (result) => {
			if (result.authSuccess) {
				return new Response(DEFAULT_SUCCESS_HTML, {
					headers: { 'content-type': 'text/html' },
				});
			}
			return new Response(
				`Authorization failed: ${result.authError ?? 'unknown'}`,
				{ status: 400, headers: { 'content-type': 'text/plain' } },
			);
		},
	});
}

/**
 * Create a `FlueAgentMcp` facade wrapping the DO's MCPClientManager.
 */
export function createAgentMcpFacade(mcp: McpClientManagerLike): FlueAgentMcp {
	return {
		async addServer(options: FlueAgentMcpServerOptions): Promise<{ id: string }> {
			const sdkOptions: Record<string, unknown> = {};
			if (options.transport) {
				sdkOptions.transport = { type: options.transport };
			}
			if (options.headers) {
				sdkOptions.transport = {
					...(sdkOptions.transport as Record<string, unknown> | undefined),
					headers: options.headers,
				};
			}
			const id = await mcp.addServer(options.url, Object.keys(sdkOptions).length > 0 ? sdkOptions : undefined);
			return { id };
		},

		async removeServer(id: string): Promise<void> {
			await mcp.removeServer(id);
		},

		getState(): FlueAgentMcpState {
			const raw = mcp.getMcpServers();
			const servers: FlueAgentMcpState['servers'] = {};
			for (const [id, srv] of Object.entries(raw.servers)) {
				servers[id] = {
					name: srv.name,
					server_url: srv.server_url,
					auth_url: srv.auth_url,
					state: srv.state,
					error: srv.error,
				};
			}
			return {
				servers,
				tools: raw.tools.map((t) => ({
					serverId: t.serverId,
					name: t.name,
					description: t.description,
					inputSchema: t.inputSchema,
				})),
			};
		},
	};
}
