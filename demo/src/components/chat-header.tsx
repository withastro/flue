import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'
import { SidebarTrigger } from '@/components/ui/sidebar'

export function ChatHeader({ title, agentName }: { title: string; agentName: string }) {
  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b border-border px-3">
      <SidebarTrigger />
      <Separator orientation="vertical" className="mr-1 h-5" />
      <h1 className="truncate text-sm font-medium">{title}</h1>
      {agentName ? (
        <Badge variant="secondary" className="ml-auto font-mono text-xs">
          {agentName}
        </Badge>
      ) : null}
    </header>
  )
}
