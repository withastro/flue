import { useFlueAgent, useFlueClient } from '@flue/react'
import { AlertCircle } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { DEFAULT_TITLE, useConversations } from '@/state/conversations'
import { useSettings } from '@/state/settings'
import { ChatHeader } from '../chat-header'
import { Composer } from './composer'
import { MessageList } from './message-list'

function truncateTitle(message: string): string {
  const clean = message.replace(/\s+/g, ' ').trim()
  return clean.length > 48 ? `${clean.slice(0, 48)}…` : clean
}

export function ChatView({ conversationId }: { conversationId: string }) {
  const conversations = useConversations()
  const client = useFlueClient()
  const { connection } = useSettings()
  const conversation = conversations.get(conversationId)
  const agentName = conversation?.agentName ?? ''

  const agent = useFlueAgent({ name: agentName, id: conversationId, live: connection.live })
  const busy = agent.status === 'submitted' || agent.status === 'streaming'
  const [canceling, setCanceling] = useState(false)
  const [cancelError, setCancelError] = useState<Error | undefined>()
  const sentPendingRef = useRef(false)

  const handleSend = async (message: string) => {
    const current = conversations.get(conversationId)
    if (current && current.title === DEFAULT_TITLE) {
      conversations.rename(conversationId, truncateTitle(message))
    }
    conversations.touch(conversationId)
    setCancelError(undefined)
    try {
      await agent.sendMessage(message)
    } catch {
      // Surfaced through agent.error below.
    }
  }

  const handleCancel = async () => {
    if (!agentName || !busy || canceling) return
    setCanceling(true)
    setCancelError(undefined)
    try {
      const result = await client.agents.abort(agentName, conversationId)
      conversations.touch(conversationId)
      if (!result.aborted) setCanceling(false)
    } catch (error) {
      setCanceling(false)
      setCancelError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  useEffect(() => {
    if (!busy) setCanceling(false)
  }, [busy])

  // Send a queued first message handed off from the new-chat screen. This view
  // is keyed by conversation id (router.tsx), so a mount-only effect is the
  // intended behavior and `takePending` is idempotent regardless.
  useEffect(() => {
    if (sentPendingRef.current) return
    const pending = conversations.takePending(conversationId)
    if (pending) {
      sentPendingRef.current = true
      void handleSend(pending)
    }
    // oxlint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  return (
    <div className="flex h-svh min-h-0 flex-1 flex-col overflow-hidden">
      <ChatHeader title={conversation?.title ?? 'Chat'} agentName={agentName} />
      <MessageList
        messages={agent.messages}
        status={agent.status}
        failedSends={agent.failedSends}
      />
      <div className="mx-auto w-full max-w-3xl shrink-0 px-4 pb-4">
        {agent.error || cancelError ? (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            <AlertCircle className="mt-0.5 size-4 shrink-0" />
            <span className="break-words">{(agent.error ?? cancelError)?.message}</span>
          </div>
        ) : null}
        <Composer
          onSend={handleSend}
          onCancel={handleCancel}
          busy={busy}
          canceling={canceling}
          autoFocus
          placeholder="Message the agent…"
        />
        <p className="mt-2 text-center text-xs text-muted-foreground">
          Connected to <span className="font-medium">{agentName}</span>. Press Enter to send,
          Shift+Enter for a new line.
        </p>
      </div>
    </div>
  )
}
