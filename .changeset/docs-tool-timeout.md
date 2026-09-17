---
'@flue/cli': patch
'@flue/runtime': patch
'@flue/sdk': patch
---

The Tools guide and agent API reference now document `timeoutMs` on tool definitions: a per-call execution bound that aborts the tool's `context.signal` and settles the call with a `ToolTimeoutError` instead of letting one hung call consume the submission's durability budget.
