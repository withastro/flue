import type { ConversationLiveMode } from '@flue/sdk'

/**
 * A configured connection to a single agent. The whole target is expressed as
 * one URL — change the URL to talk to a different agent. Everything after
 * `/agents/` is the agent name; the prefix is the SDK base URL.
 *
 * @example `http://localhost:3583/api/agents/helper`
 */
export interface Connection {
  /** Full agent endpoint, e.g. `http://localhost:3583/api/agents/helper`. */
  agentUrl: string
  /** Optional bearer token sent as `Authorization: Bearer <token>`. */
  token?: string
  /** Transport for live conversation updates: `'sse'` or `'long-poll'`. */
  live: ConversationLiveMode
}

/**
 * A chat in the sidebar. Messages themselves live on the Flue server (durable
 * streams); we only persist enough metadata to list and reopen conversations.
 * The conversation `id` doubles as the agent instance id.
 */
export interface Conversation {
  id: string
  title: string
  /** Agent the conversation was started against. */
  agentName: string
  createdAt: number
  updatedAt: number
}
