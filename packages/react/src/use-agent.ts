import type { FlueClient, LiveMode } from '@flue/sdk';
import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { type AgentSnapshot, emptyAgentState } from './agent-reducer.ts';
import { type AgentHistory, AgentSession, type SendMessageOptions } from './agent-session.ts';
import { useResolvedFlueClient } from './provider.ts';

const emptySnapshot: AgentSnapshot = {
	messages: emptyAgentState.messages,
	status: 'idle',
	historyReady: false,
	error: undefined,
};
const emptySubscribe = () => () => {};

export interface UseFlueAgentOptions {
	name: string;
	id?: string;
	history?: AgentHistory;
	live?: LiveMode;
	client?: FlueClient;
}

export interface UseFlueAgentResult extends AgentSnapshot {
	sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
}

export function useFlueAgent(options: UseFlueAgentOptions): UseFlueAgentResult {
	const client = useResolvedFlueClient(options.client);
	const history = options.history ?? 'all';
	const live = options.live ?? true;
	const session = useMemo(
		() => (options.id ? new AgentSession(client, options.name, options.id, history, live) : undefined),
		[client, options.name, options.id, history, live],
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
	};
}
