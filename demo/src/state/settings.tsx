import type { FlueClient } from '@flue/sdk'
import { createContext, type ReactNode, useContext, useMemo, useState } from 'react'
import { createClientFor, DEFAULT_CONNECTION, parseAgentUrl } from '@/lib/flue-client'
import { loadJSON, saveJSON, STORAGE_KEYS } from '@/lib/storage'
import type { Connection } from '@/lib/types'

interface SettingsContextValue {
  connection: Connection
  client: FlueClient
  /** Agent name derived from the connection URL (the part after `/agents/`). */
  agentName: string
  setConnection: (connection: Connection) => void
}

const SettingsContext = createContext<SettingsContextValue | undefined>(undefined)

/** Coerce whatever is in storage into a valid connection, defaulting any gaps. */
function normalizeConnection(stored: unknown): Connection {
  if (stored && typeof stored === 'object') {
    const value = stored as Partial<Connection>
    if (typeof value.agentUrl === 'string' && value.agentUrl.trim()) {
      // Conversation observation supports SSE (default) and long-poll. Older
      // stored values (`true` / `false`) fall back to the default transport.
      const live =
        value.live === 'long-poll' || value.live === 'sse' ? value.live : DEFAULT_CONNECTION.live
      return {
        agentUrl: value.agentUrl,
        token: typeof value.token === 'string' ? value.token : undefined,
        live,
      }
    }
  }
  return { ...DEFAULT_CONNECTION }
}

export function SettingsProvider({ children }: { children: ReactNode }) {
  const [connection, setConnectionState] = useState<Connection>(() =>
    normalizeConnection(loadJSON<unknown>(STORAGE_KEYS.connection, null)),
  )

  const setConnection = (next: Connection) => {
    setConnectionState(next)
    saveJSON(STORAGE_KEYS.connection, next)
  }

  // Recreate the client only when the base URL or token actually changes; the
  // transport (`live`) is applied per-observe, not baked into the client.
  const client = useMemo(
    () => createClientFor(connection),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [connection.agentUrl, connection.token],
  )

  const value = useMemo<SettingsContextValue>(
    () => ({
      connection,
      client,
      agentName: parseAgentUrl(connection.agentUrl).agentName,
      setConnection,
    }),
    // oxlint-disable-next-line react-hooks/exhaustive-deps
    [connection, client],
  )

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (!value) throw new Error('useSettings() must be used within a SettingsProvider')
  return value
}
