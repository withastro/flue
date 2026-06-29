import type { ConversationLiveMode } from '@flue/sdk'
import { Settings } from 'lucide-react'
import { type ReactNode, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { DEFAULT_CONNECTION } from '@/lib/flue-client'
import type { Connection } from '@/lib/types'
import { usePreferences } from '@/state/preferences'
import { useSettings } from '@/state/settings'

/** Transport options map to the SDK `ConversationLiveMode`, keyed by stable strings. */
const TRANSPORTS: { value: string; label: string; live: ConversationLiveMode }[] = [
  { value: 'sse', label: 'Live · SSE (default)', live: 'sse' },
  { value: 'long-poll', label: 'Long-poll', live: 'long-poll' },
]

function liveToValue(live: ConversationLiveMode): string {
  return live === 'long-poll' ? 'long-poll' : 'sse'
}

function valueToLive(value: string): ConversationLiveMode {
  return TRANSPORTS.find((transport) => transport.value === value)?.live ?? 'sse'
}

export function SettingsDialog({ trigger }: { trigger: ReactNode }) {
  const { connection, setConnection } = useSettings()
  const { showThinking, setShowThinking } = usePreferences()
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<Connection>(connection)
  const [thinking, setThinking] = useState(showThinking)

  // Re-seed the form whenever it opens so it reflects the live settings.
  useEffect(() => {
    if (open) {
      setDraft(connection)
      setThinking(showThinking)
    }
  }, [open, connection, showThinking])

  const save = () => {
    setConnection({
      agentUrl: draft.agentUrl.trim() || DEFAULT_CONNECTION.agentUrl,
      token: draft.token?.trim() || undefined,
      live: draft.live,
    })
    setShowThinking(thinking)
    setOpen(false)
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Settings className="size-4" /> Settings
          </DialogTitle>
          <DialogDescription>
            Point the demo at any agent by URL. Start a server with{' '}
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">flue dev</code>.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="agent-url">Agent URL</Label>
            <Input
              id="agent-url"
              value={draft.agentUrl}
              onChange={(event) => setDraft({ ...draft, agentUrl: event.target.value })}
              placeholder="http://localhost:3583/api/agents/helper"
            />
            <p className="text-xs text-muted-foreground">
              Everything after <span className="font-mono">/agents/</span> is the agent name.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="transport">Transport</Label>
            <Select
              value={liveToValue(draft.live)}
              onValueChange={(value) => setDraft({ ...draft, live: valueToLive(value) })}
            >
              <SelectTrigger id="transport" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TRANSPORTS.map((transport) => (
                  <SelectItem key={transport.value} value={transport.value}>
                    {transport.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="token">Bearer token (optional)</Label>
            <Input
              id="token"
              type="password"
              value={draft.token ?? ''}
              onChange={(event) => setDraft({ ...draft, token: event.target.value })}
              placeholder="for agents behind a route auth check"
            />
          </div>

          <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
            <div className="min-w-0">
              <Label htmlFor="show-thinking" className="cursor-pointer">
                Show thinking
              </Label>
              <p className="text-xs text-muted-foreground">Reveal the model's reasoning.</p>
            </div>
            <Switch id="show-thinking" checked={thinking} onCheckedChange={setThinking} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button onClick={save}>Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
