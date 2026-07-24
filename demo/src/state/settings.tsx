import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';
import { agentNameFromUrl, DEFAULT_CONNECTION } from '@/lib/flue-client';
import { loadJSON, saveJSON, STORAGE_KEYS } from '@/lib/storage';
import type { Connection } from '@/lib/types';

interface SettingsContextValue {
	connection: Connection;
	/** Agent name derived from the connection URL (the part after `/agents/`). */
	agentName: string;
	setConnection: (connection: Connection) => void;
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined);

/** Coerce whatever is in storage into a valid connection, defaulting any gaps. */
function normalizeConnection(stored: unknown): Connection {
	if (stored && typeof stored === 'object') {
		const value = stored as Partial<Connection>;
		if (typeof value.agentUrl === 'string' && value.agentUrl.trim()) {
			// Conversation observation supports SSE (default) and long-poll. Older
			// stored values (`true` / `false`) fall back to the default transport.
			const live =
				value.live === 'long-poll' || value.live === 'sse' ? value.live : DEFAULT_CONNECTION.live;
			return {
				agentUrl: value.agentUrl,
				token: typeof value.token === 'string' ? value.token : undefined,
				live,
			};
		}
	}
	return { ...DEFAULT_CONNECTION };
}

export function SettingsProvider({ children }: { children: ReactNode }) {
	const [connection, setConnectionState] = useState<Connection>(() =>
		normalizeConnection(loadJSON<unknown>(STORAGE_KEYS.connection, null)),
	);

	const setConnection = (next: Connection) => {
		setConnectionState(next);
		saveJSON(STORAGE_KEYS.connection, next);
	};

	const value = useMemo<SettingsContextValue>(
		() => ({
			connection,
			agentName: agentNameFromUrl(connection.agentUrl),
			setConnection,
		}),
		// oxlint-disable-next-line react-hooks/exhaustive-deps
		[connection],
	);

	return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
	const value = useContext(SettingsContext);
	if (!value) throw new Error('useSettings() must be used within a SettingsProvider');
	return value;
}
