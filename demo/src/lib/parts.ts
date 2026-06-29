import type { FlueConversationPart } from '@flue/react'

/**
 * Whether a conversation part renders anything given the current preferences.
 * Reasoning is only shown when "show thinking" is on; every other part always
 * renders. Used to drop assistant messages that would render empty and to decide
 * when the transient "Thinking…" indicator is needed.
 */
export function isVisiblePart(part: FlueConversationPart, showThinking: boolean): boolean {
  return part.type === 'reasoning' ? showThinking : true
}
