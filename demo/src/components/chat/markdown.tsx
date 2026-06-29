import { Streamdown } from 'streamdown'

/**
 * Markdown renderer for assistant text. Streamdown is purpose-built for
 * streaming LLM output: it parses unterminated blocks gracefully and prestyles
 * GitHub-flavored Markdown out of the box, so a partial chunk renders cleanly
 * on every update. Streamdown memoizes internally, so no wrapper memo is needed.
 */
export function Markdown({ children }: { children: string }) {
  return <Streamdown className="text-sm text-foreground">{children}</Streamdown>
}
