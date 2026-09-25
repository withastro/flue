---
'@flue/runtime': minor
'@flue/sdk': minor
---

Add bounded conversation history reads so long-running chats no longer transfer the whole transcript on every page load or reconnect.

- `client.history({ limit })` reads only the newest messages. The snapshot keeps the head `offset`, the `incarnation`, and every settlement, and adds a `before` cursor.
- `client.historyBefore(cursor, { limit })` reads older messages one page at a time. The page size is required.
- `client.observe({ limit })` hydrates only the newest messages, then grows forward with live updates. Rehydration after a reconnect reads from the window's oldest message, so no gap opens. The runtime cuts `conversation-reset` snapshots to the same window. The observed state's `before` cursor feeds `historyBefore()`, and a changed cursor means the window re-based.
- A window never cuts out a message that can still receive live updates, such as a response still streaming above messages delivered after it. It may hold more than `limit` messages.
- Cursors are opaque and bound to one stream generation. After the stream is reset and regrown, reads with an old cursor are rejected with `history_cursor_not_found` (410), even when message ids repeat, and `observe()` re-bases.
- `readSubmissionReply()` now requires `settlements`, so history pages are not accepted. It falls back to the latest assistant message only on a complete conversation, never on a bounded window where that message may belong to another submission.

Unbounded reads are unchanged. `@flue/react` still observes the whole conversation.
