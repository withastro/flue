import { createFlueClient, type FlueClient } from '@flue/sdk'
import type { Connection } from './types'

/** Out-of-the-box target: react-chat's credential-free faux assistant under `flue dev`. */
export const DEFAULT_CONNECTION: Connection = {
  agentUrl: 'http://localhost:3583/api/agents/assistant',
  live: 'sse',
}

/**
 * Split an agent URL into the SDK base URL and the agent name. The agent path is
 * `<baseUrl>/agents/<name>/<id>`, so the name is the first segment after
 * `/agents/` and the base URL is everything before it.
 */
export function parseAgentUrl(agentUrl: string): { baseUrl: string; agentName: string } {
  const trimmed = agentUrl.trim().replace(/\/+$/, '')
  const marker = '/agents/'
  const index = trimmed.lastIndexOf(marker)
  if (index === -1) return { baseUrl: trimmed, agentName: '' }
  const baseUrl = trimmed.slice(0, index)
  const rest = trimmed.slice(index + marker.length)
  const [name = ''] = rest.split('/')
  return { baseUrl, agentName: decodeURIComponent(name) }
}

export function createClientFor(connection: Connection): FlueClient {
  return createFlueClient({
    baseUrl: parseAgentUrl(connection.agentUrl).baseUrl,
    token: connection.token?.trim() || undefined,
  })
}
