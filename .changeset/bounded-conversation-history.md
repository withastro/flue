---
'@flue/runtime': minor
'@flue/sdk': minor
---

Add bounded conversation history reads so long-running chats no longer transfer the whole transcript on every page load or reconnect.

- `client.history({ limit })` reads only the newest messages. The snapshot keeps the head `offset`, the `incarnation`, and every settlement, and adds a `before` cursor.
- `client.historyBefore(cursor, { limit })` reads older messages one page at a time.
- `client.observe({ limit })` hydrates only the newest messages, then grows forward with live updates. Rehydration after a reconnect reads from the window's oldest message, so no gap opens. `conversation-reset` updates are cut back to the same window. The observed state's `before` cursor feeds `historyBefore()`.
- The runtime's `?view=history` route accepts `limit`, `before`, and `from`. An unknown cursor is rejected with `history_cursor_not_found` (410).
- `readSubmissionReply()` no longer falls back to the latest assistant message on a bounded conversation, where that message may belong to another submission.

Unbounded reads are unchanged. `@flue/react` still observes the whole conversation.
