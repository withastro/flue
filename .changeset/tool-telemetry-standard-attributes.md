---
'@flue/cli': patch
'@flue/opentelemetry': patch
'@flue/runtime': patch
'@flue/sdk': patch
---

Record tool arguments and results of every payload shape on the standard `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` attributes, so OTel backends can display them. The shape-based diversion to the vendor `flue.tool.call.*` fallback keys is removed — those keys are no longer emitted, and their constants are retained for source compatibility. Payloads record exactly as before: objects/arrays as JSON strings, strings byte-for-byte within the content budget, other scalars as their JSON form.
