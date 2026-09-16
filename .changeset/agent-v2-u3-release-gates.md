---
'@flue/runtime': minor
'@flue/sdk': minor
'@flue/postgres': patch
'@flue/mysql': patch
'@flue/libsql': patch
'@flue/mongodb': patch
'@flue/redis': patch
---

Add model-hidden durable delivery context, caller-selected FIFO delivery, safe instance quiescence and physical purge for built-in SQLite targets, and payload-free durable mutation observations. Keyed delivery replay now explicitly compares private context and delivery mode while retaining the existing idempotency-key admission path.
