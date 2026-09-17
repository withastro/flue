---
'@flue/cli': patch
'@flue/runtime': patch
'@flue/sdk': patch
---

The observability guide, OpenTelemetry ecosystem page, and Cloudflare target guide now document `contentBudgetBytes` on `createOpenTelemetryInstrumentation()` / `createCloudflareTracing()`: an override for the default 56 KiB per-span content pool, for hosts not bound by workerd's span limits.
