---
'@flue/runtime': minor
'@flue/sdk': minor
---

Conversation messages now carry a server-authored `timestamp` (ISO 8601 capture time of the underlying durable record) in `history()`, `observe()`, and `useFlueAgent`. It works for every role and for existing conversations. `metadata` remains entirely agent-authored. Conversation settlements carry the same `timestamp` for when the submission settled.
