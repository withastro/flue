/**
 * DO-backed session store. Uses setState/state directly since each DO instance
 * holds one session. Usually not needed — the generated entry point uses DO SQLite by default.
 */
import type { SessionData, SessionStore } from '../types.ts';
import { getCloudflareContext } from './context.ts';

export function store(): SessionStore {
	return {
		async save(_id: string, data: SessionData): Promise<void> {
			const { agentInstance } = getCloudflareContext();
			agentInstance.setState({ ...agentInstance.state, sessionData: data });
		},

		async load(_id: string): Promise<SessionData | null> {
			const { agentInstance } = getCloudflareContext();
			return agentInstance.state?.sessionData ?? null;
		},

		async delete(_id: string): Promise<void> {
			const { agentInstance } = getCloudflareContext();
			agentInstance.setState({ ...agentInstance.state, sessionData: null });
		},
	};
}
