import { type ConversationLiveMode, createFlueClient, type FlueClient } from '@flue/sdk';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { type AgentSnapshot, emptyAgentState } from './agent-reducer.ts';
import { AgentSession, type SendMessageOptions } from './agent-session.ts';

const emptySnapshot: AgentSnapshot = {
	messages: emptyAgentState.messages,
	status: 'idle',
	historyReady: false,
	error: undefined,
	failedSends: emptyAgentState.failedSends,
};
const emptySubscribe = () => () => {};

export interface UseFlueAgentOptions {
	/**
	 * URL of one agent conversation: wherever the application mounts the
	 * agent's routes plus the caller-chosen conversation id
	 * (`/api/agents/triage/123`). Relative URLs resolve against the browser
	 * origin; during server rendering they leave the hook dormant until
	 * hydration. Omit (together with `client`) to keep the hook dormant.
	 */
	url?: string;
	/**
	 * Pre-configured conversation client, for custom headers, auth, or fetch
	 * behavior (`createFlueClient({ url, headers })`). Takes precedence over
	 * `url`. Memoize it — a new client instance replaces the session.
	 */
	client?: FlueClient;
	live?: ConversationLiveMode;
}

export interface UseFlueAgentResult extends AgentSnapshot {
	sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
	/**
	 * Re-checks the conversation and resumes live updates. Call this to observe a
	 * conversation that may be created out-of-band after mount: when `status` is
	 * `'idle'` with no messages (the conversation is absent), retry on whatever
	 * schedule the application chooses.
	 */
	refresh(): void;
}

function isAbsoluteUrl(url: string): boolean {
	try {
		new URL(url);
		return true;
	} catch {
		return false;
	}
}

export function useFlueAgent(options: UseFlueAgentOptions = {}): UseFlueAgentResult {
	// Default to SSE: lower-latency token-by-token streaming for chat UIs.
	// Safe because React consumes only via observe(), which dedupes redelivered
	// chunks; the SDK transport falls back to long-poll if SSE can't stay open.
	const live = options.live ?? 'sse';
	const client = useMemo(() => {
		if (options.client) return options.client;
		if (options.url === undefined) return undefined;
		// A relative URL resolves against the browser origin; server rendering
		// has none, so the hook stays dormant (its documented SSR contract:
		// empty, idle state, no connections) and constructs the client on the
		// hydrated browser render instead of throwing.
		if (globalThis.location === undefined && !isAbsoluteUrl(options.url)) return undefined;
		return createFlueClient({ url: options.url });
	}, [options.client, options.url]);
	const session = useMemo(
		() => (client ? new AgentSession(client, live) : undefined),
		[client, live],
	);
	useEffect(() => {
		session?.start();
		return () => session?.dispose();
	}, [session]);
	const snapshot = useSyncExternalStore(
		session?.subscribe ?? emptySubscribe,
		session?.getSnapshot ?? (() => emptySnapshot),
		() => emptySnapshot,
	);
	return {
		...snapshot,
		sendMessage: session
			? session.sendMessage.bind(session)
			: async () => {
					throw new Error('useFlueAgent() cannot send without a conversation url');
				},
		refresh: session ? session.refresh : () => {},
	};
}
