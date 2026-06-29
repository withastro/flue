import { ArrowUp, Loader2, Square } from 'lucide-react'
import { type KeyboardEvent, useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

interface ComposerProps {
  onSend: (message: string) => void
  onCancel?: () => void
  disabled?: boolean
  busy?: boolean
  canceling?: boolean
  placeholder?: string
  autoFocus?: boolean
}

export function Composer({
  onSend,
  onCancel,
  disabled,
  busy,
  canceling,
  placeholder,
  autoFocus,
}: ComposerProps) {
  const [value, setValue] = useState('')
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  // Auto-grow the textarea up to a max height.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`
  }, [value])

  const submit = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled || busy) return
    onSend(trimmed)
    setValue('')
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  }

  const buttonLabel = busy ? 'Stop response' : 'Send message'

  return (
    <div
      className={cn(
        'flex items-end gap-2 rounded-2xl border border-border bg-card p-2 shadow-sm focus-within:ring-1 focus-within:ring-ring',
      )}
    >
      <textarea
        ref={textareaRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={onKeyDown}
        rows={1}
        autoFocus={autoFocus}
        placeholder={placeholder ?? 'Send a message…'}
        className="max-h-[200px] flex-1 resize-none bg-transparent px-2 py-1.5 text-sm outline-none placeholder:text-muted-foreground"
      />
      <Button
        type="button"
        size="icon"
        className="size-9 shrink-0 rounded-xl"
        disabled={disabled || (busy ? canceling || !onCancel : value.trim().length === 0)}
        onClick={busy ? onCancel : submit}
        aria-label={buttonLabel}
      >
        {canceling ? (
          <Loader2 className="size-4 animate-spin" />
        ) : busy ? (
          <Square className="size-3.5 fill-current" />
        ) : (
          <ArrowUp className="size-4" />
        )}
      </Button>
    </div>
  )
}
