import { createFlueClient, type FlueClient } from '@flue/sdk';
import type { Connection } from './types';

/** Out-of-the-box target: react-chat's credential-free faux assistant under `vite dev`. */
export const DEFAULT_CONNECTION: Connection = {
	agentUrl: 'http://localhost:3583/api/agents/assistant',
	live: 'sse',
};

/**
 * Derive a display name from an agent URL. The conventional layout is
 * `<prefix>/agents/<name>`, so the name is the segment after `/agents/`;
 * otherwise fall back to the last path segment.
 */
export function agentNameFromUrl(agentUrl: string): string {
	const trimmed = agentUrl.trim().replace(/\/+$/, '');
	const marker = '/agents/';
	const index = trimmed.lastIndexOf(marker);
	const rest =
		index === -1 ? (trimmed.split('/').at(-1) ?? '') : trimmed.slice(index + marker.length);
	const [name = ''] = rest.split('/');
	return decodeURIComponent(name);
}

/**
 * A client addresses one conversation by URL: the configured agent mount URL
 * plus the caller-chosen conversation id.
 */
export function createConversationClient(
	connection: Connection,
	conversationId: string,
): FlueClient {
	const agentUrl = connection.agentUrl.trim().replace(/\/+$/, '');
	return createFlueClient({
		url: `${agentUrl}/${encodeURIComponent(conversationId)}`,
		token: connection.token?.trim() || undefined,
	});
}
