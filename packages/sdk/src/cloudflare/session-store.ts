/**
 * DO-backed session store. Uses setState/state directly. Usually not needed —
 * the generated entry point uses DO SQLite by default.
 */
import type { SessionData, SessionStore } from '../types.ts';
import { getCloudflareContext } from './context.ts';

export function store(): SessionStore {
	return {
		async save(id: string, data: SessionData): Promise<void> {
			const { agentInstance } = getCloudflareContext();
			const sessions = { ...(agentInstance.state?.sessions ?? {}) };
			sessions[id] = data;
			agentInstance.setState({ ...agentInstance.state, sessions });
		},

		async load(id: string): Promise<SessionData | null> {
			const { agentInstance } = getCloudflareContext();
			return agentInstance.state?.sessions?.[id] ?? null;
		},

		async delete(id: string): Promise<void> {
			const { agentInstance } = getCloudflareContext();
			const sessions = { ...(agentInstance.state?.sessions ?? {}) };
			delete sessions[id];
			agentInstance.setState({ ...agentInstance.state, sessions });
		},
	};
}
