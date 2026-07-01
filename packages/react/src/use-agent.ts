import type { ConversationLiveMode, FlueClient } from '@flue/sdk';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { type AgentSnapshot, emptyAgentState } from './agent-reducer.ts';
import { AgentSession, type SendMessageOptions } from './agent-session.ts';
import { useResolvedFlueClient } from './provider.ts';

const emptySnapshot: AgentSnapshot = {
	messages: emptyAgentState.messages,
	status: 'idle',
	historyReady: false,
	error: undefined,
	failedSends: emptyAgentState.failedSends,
};
const emptySubscribe = () => () => {};

export interface UseFlueAgentOptions {
	name: string;
	id?: string;
	live?: ConversationLiveMode;
	client?: FlueClient;
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

export function useFlueAgent(options: UseFlueAgentOptions): UseFlueAgentResult {
	const client = useResolvedFlueClient(options.client);
	// Default to SSE: lower-latency token-by-token streaming for chat UIs.
	// Safe because React consumes only via observe(), which dedupes redelivered
	// chunks; the SDK transport falls back to long-poll if SSE can't stay open.
	const live = options.live ?? 'sse';
	const session = useMemo(
		() => (options.id ? new AgentSession(client, options.name, options.id, live) : undefined),
		[client, options.name, options.id, live],
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
					throw new Error('useFlueAgent() cannot send without an agent id');
				},
		refresh: session ? session.refresh : () => {},
	};
}
