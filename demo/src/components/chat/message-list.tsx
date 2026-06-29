import type { AgentStatus, FailedSend, FlueConversationMessage } from '@flue/react'
import { Marker, MarkerContent, MarkerIcon } from '@/components/ui/marker'
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from '@/components/ui/message-scroller'
import { Spinner } from '@/components/ui/spinner'
import { isVisiblePart } from '@/lib/parts'
import { usePreferences } from '@/state/preferences'
import { MessageItem, type MessageGroup } from './message-item'

/**
 * Group adjacent messages from the same logical speaker turn, dropping assistant
 * messages with nothing to show (e.g. only hidden reasoning) so they don't render
 * an empty avatar row. Tracked assistant messages share `submissionId`; untracked
 * messages fall back to adjacent same-role grouping.
 *
 * Aborts are detected purely from the conversation itself: the runtime appends a
 * canonical `submission_aborted` advisory message, which we turn into an
 * assistant-side "Response was stopped." event on the preceding turn. Sends that
 * were aborted before the server accepted them surface via `abortedLocalIds`.
 */
function groupMessages(
  messages: FlueConversationMessage[],
  showThinking: boolean,
  abortedLocalIds: Set<string>,
): MessageGroup[] {
  const groups: MessageGroup[] = []

  const pushAbortEvent = (id: string) => {
    const last = groups.at(-1)
    if (last?.role === 'assistant') {
      last.event = { type: 'response-aborted', text: 'Response was stopped.' }
      return
    }

    groups.push({
      id: `abort:${id}`,
      role: 'assistant',
      messages: [],
      event: { type: 'response-aborted', text: 'Response was stopped.' },
    })
  }

  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      !message.parts.some((part) => isVisiblePart(part, showThinking))
    ) {
      continue
    }

    const advisorySubmissionId = abortAdvisorySubmissionId(message)
    if (advisorySubmissionId) {
      pushAbortEvent(advisorySubmissionId)
      continue
    }

    const last = groups.at(-1)
    const sameTrackedTurn =
      !last?.event &&
      last?.role === message.role &&
      message.submissionId !== undefined &&
      last.messages.at(-1)?.submissionId === message.submissionId
    const sameUntrackedRun =
      !last?.event &&
      last?.role === message.role &&
      message.submissionId === undefined &&
      last.messages.at(-1)?.submissionId === undefined
    if (sameTrackedTurn || sameUntrackedRun) last.messages.push(message)
    else groups.push({ id: message.id, role: message.role, messages: [message] })

    if (abortedLocalIds.has(message.id)) pushAbortEvent(message.id)
  }
  return groups
}

function abortAdvisorySubmissionId(message: FlueConversationMessage): string | undefined {
  if (message.role !== 'user' || !message.id.includes('submission_aborted')) return undefined
  const aborted = message.parts.some(
    (part) => part.type === 'text' && part.text.toLowerCase().includes('submission was aborted'),
  )
  if (!aborted) return undefined
  return message.id.replace(/^.*entry_submission_aborted_/, '') || message.id
}

function isAbortFailure(error: Error): boolean {
  if (error.message.includes('[submission_aborted]') || error.message.includes('Submission was aborted')) {
    return true
  }
  const body = (error as { body?: unknown }).body
  if (!body || typeof body !== 'object' || !('error' in body)) return false
  const value = (body as { error?: { type?: unknown } }).error?.type
  return value === 'submission_aborted'
}

export function MessageList({
  messages,
  status,
  failedSends,
}: {
  messages: FlueConversationMessage[]
  status: AgentStatus
  failedSends: FailedSend[]
}) {
  const { showThinking } = usePreferences()
  const busy = status === 'submitted' || status === 'streaming'
  const abortedLocalIds = new Set(
    failedSends.filter((send) => isAbortFailure(send.error)).map((send) => send.id),
  )
  const groups = groupMessages(messages, showThinking, abortedLocalIds)
  const lastGroup = groups.at(-1)
  const failedById = new Map(
    failedSends
      .filter((send) => !abortedLocalIds.has(send.id))
      .map((send) => [send.id, send.error]),
  )

  // Show the transient "Thinking…" indicator while the agent is busy and nothing
  // visible is actively streaming (the streaming caret / running tool already
  // signal activity in those cases). This covers the initial wait, hidden
  // reasoning, and the gap between turns.
  const lastPart = messages.at(-1)?.parts.at(-1)
  const activeStreaming =
    !!lastPart &&
    ((lastPart.type === 'text' && lastPart.state === 'streaming') ||
      (lastPart.type === 'reasoning' && showThinking && lastPart.state === 'streaming') ||
      (lastPart.type === 'dynamic-tool' && lastPart.state === 'input-available'))
  const thinking = busy && !activeStreaming

  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <MessageScroller className="min-h-0 flex-1">
        <MessageScrollerViewport>
          <MessageScrollerContent
            aria-busy={busy}
            className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6"
          >
            {groups.map((group) => (
              <MessageScrollerItem key={group.id} messageId={group.id}>
                <MessageItem
                  group={group}
                  settled={!(busy && group === lastGroup)}
                  failedById={failedById}
                />
              </MessageScrollerItem>
            ))}
            {thinking ? (
              <MessageScrollerItem>
                <Marker role="status">
                  <MarkerIcon>
                    <Spinner />
                  </MarkerIcon>
                  <MarkerContent className="shimmer">Thinking…</MarkerContent>
                </Marker>
              </MessageScrollerItem>
            ) : null}
          </MessageScrollerContent>
        </MessageScrollerViewport>
        <MessageScrollerButton />
      </MessageScroller>
    </MessageScrollerProvider>
  )
}
