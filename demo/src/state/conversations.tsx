import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { loadJSON, saveJSON, STORAGE_KEYS } from '@/lib/storage'
import type { Conversation } from '@/lib/types'

interface ConversationsContextValue {
  conversations: Conversation[]
  create: (agentName: string) => Conversation
  remove: (id: string) => void
  rename: (id: string, title: string) => void
  touch: (id: string) => void
  get: (id: string) => Conversation | undefined
  /** Stash a first message to be sent once the chat view mounts. */
  setPending: (id: string, message: string) => void
  takePending: (id: string) => string | undefined
}

const ConversationsContext = createContext<ConversationsContextValue | undefined>(undefined)

export const DEFAULT_TITLE = 'New chat'

const sortByUpdated = (list: Conversation[]) =>
  [...list].sort((a, b) => b.updatedAt - a.updatedAt)

export function ConversationsProvider({ children }: { children: ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    sortByUpdated(loadJSON<Conversation[]>(STORAGE_KEYS.conversations, [])),
  )
  const pending = useRef(new Map<string, string>())

  // Persist whenever the list changes; functional updates below stay correct
  // even when several mutations happen in the same tick.
  useEffect(() => {
    saveJSON(STORAGE_KEYS.conversations, conversations)
  }, [conversations])

  const value = useMemo<ConversationsContextValue>(
    () => ({
      conversations,
      create(agentName) {
        const now = Date.now()
        const conversation: Conversation = {
          id: crypto.randomUUID(),
          title: DEFAULT_TITLE,
          agentName,
          createdAt: now,
          updatedAt: now,
        }
        setConversations((prev) => sortByUpdated([conversation, ...prev]))
        return conversation
      },
      remove(id) {
        pending.current.delete(id)
        setConversations((prev) => prev.filter((conversation) => conversation.id !== id))
      },
      rename(id, title) {
        setConversations((prev) =>
          prev.map((conversation) =>
            conversation.id === id ? { ...conversation, title } : conversation,
          ),
        )
      },
      touch(id) {
        setConversations((prev) =>
          sortByUpdated(
            prev.map((conversation) =>
              conversation.id === id
                ? { ...conversation, updatedAt: Date.now() }
                : conversation,
            ),
          ),
        )
      },
      get(id) {
        return conversations.find((conversation) => conversation.id === id)
      },
      setPending(id, message) {
        pending.current.set(id, message)
      },
      takePending(id) {
        const message = pending.current.get(id)
        pending.current.delete(id)
        return message
      },
    }),
    [conversations],
  )

  return (
    <ConversationsContext.Provider value={value}>{children}</ConversationsContext.Provider>
  )
}

export function useConversations(): ConversationsContextValue {
  const value = useContext(ConversationsContext)
  if (!value) throw new Error('useConversations() must be used within a ConversationsProvider')
  return value
}
