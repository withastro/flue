import type { FlueConversationPart } from '@flue/react'
import {
  Bot,
  FilePen,
  FilePlus,
  FileText,
  FolderSearch,
  type LucideIcon,
  Search,
  Sparkles,
  Terminal,
  Wrench,
} from 'lucide-react'
import type { ReactNode } from 'react'

type ToolPart = Extract<FlueConversationPart, { type: 'dynamic-tool' }>

interface ToolDisplay {
  icon: LucideIcon
  summary: ReactNode
}

/** Read a string field off an arbitrary tool-input object. */
function field(input: unknown, key: string): string | undefined {
  if (input && typeof input === 'object' && key in input) {
    const value = (input as Record<string, unknown>)[key]
    if (typeof value === 'string') return value
  }
  return undefined
}

/**
 * The value of the first argument, for tools without a custom renderer. Mirrors
 * how the built-ins surface their primary argument (e.g. a file path) so every
 * tool reads as `<name> <value>`. Returns nothing when there are no scalar args.
 */
function firstArg(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined
  const [value] = Object.values(input as Record<string, unknown>)
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

/** Render a `<verb> <argument>` one-liner, e.g. `read /path/to/file.ts`. */
function command(verb: string, arg?: string): ReactNode {
  return (
    <span className="flex min-w-0 items-baseline gap-2 font-mono">
      <span>{verb}</span>
      {arg ? <span className="truncate text-muted-foreground">{arg}</span> : null}
    </span>
  )
}

/**
 * Summarize a tool call as an icon + one line. Flue's built-in tools get custom
 * renderers (e.g. `read /path/file.ts`); the framework `task` tool names the
 * subagent it delegated to; unknown tools fall back to their bare name.
 */
export function describeToolCall(part: ToolPart): ToolDisplay {
  const input = part.input
  switch (part.toolName) {
    case 'read':
      return { icon: FileText, summary: command('read', field(input, 'path')) }
    case 'write':
      return { icon: FilePlus, summary: command('write', field(input, 'path')) }
    case 'edit':
      return { icon: FilePen, summary: command('edit', field(input, 'path')) }
    case 'bash':
      return { icon: Terminal, summary: command('bash', field(input, 'command')) }
    case 'grep':
      return { icon: Search, summary: command('grep', field(input, 'pattern')) }
    case 'glob':
      return { icon: FolderSearch, summary: command('glob', field(input, 'pattern')) }
    case 'activate_skill':
      return { icon: Sparkles, summary: command('activate skill', field(input, 'name')) }
    case 'task':
      return {
        icon: Bot,
        summary: (
          <span className="min-w-0 truncate">
            Delegated to <span className="font-mono">{field(input, 'agent') ?? 'agent'}</span>
          </span>
        ),
      }
    default:
      return { icon: Wrench, summary: command(part.toolName, firstArg(input)) }
  }
}
