import { useEffect, useRef, useState } from 'react'

// The SDK delivers streamed deltas in coalesced bursts (~1s apart). Rather than
// dump each burst in one paint, reveal the newly-arrived characters over the
// following window so text flows in smoothly.
const REVEAL_WINDOW_MS = 1000 // drain whatever just arrived over ~this long
const MIN_WORDS_PER_SECOND = 15 // ...but never crawl slower than this
const AVG_CHARS_PER_WORD = 6 // rough words→chars conversion for the rate floor
const MAX_FRAME_MS = 100 // clamp dt so a backgrounded tab doesn't dump on return

/**
 * Reveal up to `lenFloat` characters of `full`, but only on word boundaries: the
 * word under the cursor is shown in full (plus its trailing whitespace) so a
 * partial word never flashes. Markdown stays parseable since the result is
 * always a prefix of `full`.
 */
function revealedSlice(full: string, lenFloat: number): string {
  const idx = Math.floor(lenFloat)
  if (idx >= full.length) return full
  if (idx <= 0) return ''
  let cut = idx
  while (cut < full.length && !/\s/.test(full[cut]!)) cut++
  while (cut < full.length && /\s/.test(full[cut]!)) cut++
  return full.slice(0, cut)
}

/**
 * Smoothly reveal streaming text. `text` jumps forward in ~1s bursts as the SDK
 * applies each delta batch; this drips those characters out over the next ~1s at
 * an adaptive rate (fast enough to clear the backlog within the window, never
 * below a readable floor), with slight per-frame variance for a natural cadence.
 * Completed/historical text (mounted with `streaming: false`) renders instantly,
 * and a wholesale change (switching conversations) snaps rather than animates.
 */
export function useSmoothedText(text: string, streaming: boolean): string {
  const targetRef = useRef(text)
  const stateRef = useRef({ shownLen: streaming ? 0 : text.length })
  const rafRef = useRef<number | undefined>(undefined)
  const lastTimeRef = useRef(0)
  const lastShownRef = useRef(streaming ? '' : text)
  const [shown, setShown] = useState(lastShownRef.current)

  useEffect(() => {
    const tick = (now: number) => {
      const full = targetRef.current
      const state = stateRef.current
      const dt = lastTimeRef.current ? Math.min(now - lastTimeRef.current, MAX_FRAME_MS) : 16
      lastTimeRef.current = now

      if (state.shownLen < full.length) {
        const remaining = full.length - state.shownLen
        const rate = Math.max(
          MIN_WORDS_PER_SECOND * AVG_CHARS_PER_WORD,
          remaining / (REVEAL_WINDOW_MS / 1000),
        )
        const variance = 0.85 + Math.random() * 0.3
        state.shownLen = Math.min(full.length, state.shownLen + (rate * dt * variance) / 1000)
        const next = revealedSlice(full, state.shownLen)
        if (next !== lastShownRef.current) {
          lastShownRef.current = next
          setShown(next)
        }
      }

      if (stateRef.current.shownLen < targetRef.current.length) {
        rafRef.current = requestAnimationFrame(tick)
      } else {
        rafRef.current = undefined
        lastTimeRef.current = 0
        if (lastShownRef.current !== targetRef.current) {
          lastShownRef.current = targetRef.current
          setShown(targetRef.current)
        }
      }
    }

    const startIfBehind = () => {
      if (rafRef.current === undefined && stateRef.current.shownLen < targetRef.current.length) {
        lastTimeRef.current = 0
        rafRef.current = requestAnimationFrame(tick)
      }
    }

    // Adopt the new target. If it's no longer a continuation of what we've shown
    // (conversation switch / reset), snap instead of animating across content.
    const prev = targetRef.current
    targetRef.current = text
    const shownPrefix = prev.slice(0, Math.floor(stateRef.current.shownLen))
    if (!text.startsWith(shownPrefix)) {
      stateRef.current.shownLen = text.length
      lastShownRef.current = text
      setShown(text)
    }
    startIfBehind()

    return () => {
      if (rafRef.current !== undefined) {
        cancelAnimationFrame(rafRef.current)
        rafRef.current = undefined
      }
    }
  }, [text])

  return shown
}
