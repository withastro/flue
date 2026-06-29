import { useNavigate } from '@tanstack/react-router'
import { Composer } from '@/components/chat/composer'
import { SidebarTrigger } from '@/components/ui/sidebar'
import { parseAgentUrl } from '@/lib/flue-client'
import { useConversations } from '@/state/conversations'
import { useSettings } from '@/state/settings'

export function NewChat() {
  const navigate = useNavigate()
  const conversations = useConversations()
  const { connection, agentName } = useSettings()
  const { baseUrl } = parseAgentUrl(connection.agentUrl)

  const start = (message: string) => {
    const conversation = conversations.create(agentName)
    conversations.setPending(conversation.id, message)
    void navigate({ to: '/c/$chatId', params: { chatId: conversation.id } })
  }

  return (
    <div className="flex h-svh flex-1 flex-col">
      <header className="flex h-14 shrink-0 items-center px-3">
        <SidebarTrigger />
      </header>
      <div className="flex flex-1 flex-col items-center justify-center px-4">
        <div className="w-full max-w-2xl text-center">
          <div className="mx-auto mb-4 flex size-12 items-center justify-center rounded-xl bg-primary text-lg font-semibold text-primary-foreground">
            F
          </div>
          <h2 className="mb-1 text-2xl font-semibold">Flue Demo Chat</h2>
          {agentName ? (
            <p className="mb-8 text-sm text-muted-foreground">
              Talking to{' '}
              <span className="font-mono font-medium text-foreground">{agentName}</span> at{' '}
              <span className="font-mono">{baseUrl}</span>
            </p>
          ) : (
            <p className="mb-8 text-sm text-muted-foreground">
              No agent configured. Open settings and set an agent URL like{' '}
              <span className="font-mono">http://localhost:3583/api/agents/helper</span>.
            </p>
          )}
          <Composer
            onSend={start}
            autoFocus
            disabled={!agentName}
            placeholder={
              agentName
                ? 'Send a message to start a conversation…'
                : 'Configure an agent URL in settings first…'
            }
          />
        </div>
      </div>
    </div>
  )
}
