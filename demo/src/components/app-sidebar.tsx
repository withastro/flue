import { Link, useNavigate, useParams } from '@tanstack/react-router'
import { MessageSquarePlus, MoreHorizontal, Settings, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
} from '@/components/ui/sidebar'
import { parseAgentUrl } from '@/lib/flue-client'
import { useConversations } from '@/state/conversations'
import { useSettings } from '@/state/settings'
import { SettingsDialog } from './settings-dialog'

export function AppSidebar() {
  const { conversations, remove } = useConversations()
  const { connection, agentName } = useSettings()
  const { baseUrl } = parseAgentUrl(connection.agentUrl)
  const navigate = useNavigate()
  const params = useParams({ strict: false }) as { chatId?: string }
  const activeId = params.chatId

  const onDelete = (id: string) => {
    remove(id)
    if (activeId === id) void navigate({ to: '/' })
  }

  return (
    <Sidebar>
      <SidebarHeader className="gap-2 p-3">
        <div className="flex items-center gap-2 px-1">
          <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground text-sm font-semibold">
            F
          </div>
          <span className="font-semibold">Flue Demo</span>
        </div>
        <Button asChild variant="outline" className="w-full justify-start gap-2">
          <Link to="/">
            <MessageSquarePlus className="size-4" />
            New chat
          </Link>
        </Button>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>Conversations</SidebarGroupLabel>
          <SidebarGroupContent>
            {conversations.length === 0 ? (
              <p className="px-2 py-1.5 text-xs text-muted-foreground">No conversations yet.</p>
            ) : (
              <SidebarMenu>
                {conversations.map((conversation) => (
                  <SidebarMenuItem key={conversation.id}>
                    <SidebarMenuButton asChild isActive={conversation.id === activeId}>
                      <Link to="/c/$chatId" params={{ chatId: conversation.id }}>
                        <span className="truncate">{conversation.title}</span>
                      </Link>
                    </SidebarMenuButton>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <SidebarMenuAction showOnHover>
                          <MoreHorizontal className="size-4" />
                        </SidebarMenuAction>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent side="right" align="start">
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => onDelete(conversation.id)}
                        >
                          <Trash2 className="size-4" />
                          Delete
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="p-3">
        <SettingsDialog
          trigger={
            <Button variant="outline" className="h-auto w-full justify-start gap-2 py-2">
              <Settings className="size-4 shrink-0" />
              <span className="flex min-w-0 flex-col items-start">
                <span className="truncate text-xs font-medium">
                  {agentName || 'No agent configured'}
                </span>
                <span className="truncate text-[0.7rem] text-muted-foreground">{baseUrl}</span>
              </span>
            </Button>
          }
        />
      </SidebarFooter>
    </Sidebar>
  )
}
