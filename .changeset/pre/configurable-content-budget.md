---
'@flue/runtime': minor
'@flue/opentelemetry': minor
---

Trace content budgets are now configurable. `createCloudflareTracing({ contentBudgetBytes })` and `createOpenTelemetryInstrumentation({ contentBudgetBytes })` override the default 56 KiB per-span content pool — raise it (e.g. `contentBudgetBytes: 200_000`) to ship fuller prompts and tool results to an observability backend that isn't bound by workerd's 64 KiB span-attribute cap, or tighten it. The 128-byte sentinel floor and the shared-pool semantics are unchanged.
