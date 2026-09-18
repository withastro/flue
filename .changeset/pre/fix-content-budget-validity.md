---
"@flue/runtime": patch
"@flue/opentelemetry": patch
---

Fix two bugs in the configurable content budget:

- An invalid `contentBudgetBytes` value (non-integer, too small, or too large) now throws a `TypeError` at setup instead of producing confusing trace content later.
- The span that records conversation compaction now honors the configured budget, so its content is truncated or shipped consistently with every other span.