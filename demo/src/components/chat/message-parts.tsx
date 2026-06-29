import type { FlueConversationPart } from '@flue/react'
import { Brain, ChevronRight, FileText } from 'lucide-react'
import { useState } from 'react'
import {
  Attachment,
  AttachmentContent,
  AttachmentMedia,
  AttachmentTitle,
} from '@/components/ui/attachment'
import { Bubble, BubbleContent } from '@/components/ui/bubble'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import { Spinner } from '@/components/ui/spinner'
import { cn } from '@/lib/utils'
import { Markdown } from './markdown'
import { describeToolCall } from './tool-display'
import { useSmoothedText } from './use-smoothed-text'

function StreamingCaret() {
  return (
    <span className="ml-0.5 inline-block h-4 w-[2px] translate-y-0.5 animate-pulse bg-foreground align-middle" />
  )
}

function TextPart({ text, streaming }: { text: string; streaming: boolean }) {
  const shown = useSmoothedText(text, streaming)
  return (
    <Bubble variant="ghost">
      <BubbleContent>
        <Markdown>{shown}</Markdown>
        {streaming || shown.length < text.length ? <StreamingCaret /> : null}
      </BubbleContent>
    </Bubble>
  )
}

/**
 * Rendered only when "show thinking" is on. Streams the live reasoning text
 * (kept open so it's visible as it arrives); once done it stays as a collapsible
 * "Reasoning" disclosure.
 */
function ReasoningPart({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(true)
  const shown = useSmoothedText(text, streaming)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1">
      <Marker asChild className="text-muted-foreground hover:text-foreground">
        <CollapsibleTrigger className="cursor-pointer">
          <MarkerIcon>
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </MarkerIcon>
          <MarkerIcon>
            <Brain className="size-3.5" />
          </MarkerIcon>
          <MarkerContent className={cn(streaming && 'shimmer')}>
            {streaming ? 'Thinking…' : 'Reasoning'}
          </MarkerContent>
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent>
        <div className="mt-1.5 border-l-2 border-border pl-3 text-sm text-muted-foreground">
          <Markdown>{shown}</Markdown>
          {streaming || shown.length < text.length ? <StreamingCaret /> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function FilePart({ part }: { part: Extract<FlueConversationPart, { type: 'file' }> }) {
  // The SDK fills `url` in (a hosted URL for recorded attachments, a `data:` URL
  // for the optimistic echo); render it directly when present.
  const title = part.filename ?? part.mediaType

  if (part.url && part.mediaType.startsWith('image/')) {
    return (
      <img
        src={part.url}
        alt={title}
        className="my-1.5 max-h-64 w-fit rounded-lg border border-border object-contain"
      />
    )
  }

  return (
    <Attachment className="my-1.5 w-fit">
      <AttachmentMedia>
        <FileText className="size-4 text-muted-foreground" />
      </AttachmentMedia>
      <AttachmentContent>
        <AttachmentTitle>
          {part.url ? (
            <a href={part.url} target="_blank" rel="noreferrer" className="hover:underline">
              {title}
            </a>
          ) : (
            title
          )}
        </AttachmentTitle>
      </AttachmentContent>
    </Attachment>
  )
}

function ToolPart({ part }: { part: Extract<FlueConversationPart, { type: 'dynamic-tool' }> }) {
  const [open, setOpen] = useState(false)
  const running = part.state === 'input-available'
  const errored = part.state === 'output-error'
  const { icon: Icon, summary } = describeToolCall(part)
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="my-1.5">
      <Marker asChild variant="border" className={cn(errored && 'text-destructive')}>
        <CollapsibleTrigger className="cursor-pointer">
          <MarkerIcon>
            <ChevronRight className={cn('size-3.5 transition-transform', open && 'rotate-90')} />
          </MarkerIcon>
          <MarkerIcon>{running ? <Spinner /> : <Icon className="size-3.5" />}</MarkerIcon>
          <MarkerContent className={cn('min-w-0', running && 'shimmer')}>{summary}</MarkerContent>
          {running ? (
            <span className="ml-auto text-xs text-muted-foreground">running…</span>
          ) : errored ? (
            <span className="ml-auto text-xs text-destructive">error</span>
          ) : null}
        </CollapsibleTrigger>
      </Marker>
      <CollapsibleContent>
        <div className="mt-1.5 space-y-2 rounded-md border border-border bg-muted/30 p-2.5 text-xs">
          <ToolPayload label="Input" value={part.input} />
          {part.state === 'output-available' ? (
            <ToolPayload label="Output" value={part.output} />
          ) : null}
          {part.state === 'output-error' ? (
            <ToolPayload label="Error" value={part.errorText} />
          ) : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}

function ToolPayload({ label, value }: { label: string; value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return (
    <div>
      <div className="mb-1 font-medium text-muted-foreground">{label}</div>
      <pre className="overflow-x-auto whitespace-pre-wrap break-words font-mono text-[0.78rem] leading-relaxed">
        {text}
      </pre>
    </div>
  )
}

export function MessagePart({ part }: { part: FlueConversationPart }) {
  switch (part.type) {
    case 'text':
      return <TextPart text={part.text} streaming={part.state === 'streaming'} />
    case 'reasoning':
      return <ReasoningPart text={part.text} streaming={part.state === 'streaming'} />
    case 'file':
      return <FilePart part={part} />
    case 'dynamic-tool':
      return <ToolPart part={part} />
    default:
      return null
  }
}
