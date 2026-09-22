---
'@flue/react': patch
---

Clarify `useFlueAgent`'s `status` contract to match the reducer's actual aggregate behavior. `status` reflects the observed conversation's activity — including submissions admitted out-of-band (webhooks, dispatches, other clients) — combined with the hook's in-memory local admission recollection. The README now documents the full precedence order (failed-local-settlement `error` → streaming text → `submitted` → active/recollected submission `streaming` → retained-failed-send `error` → `idle`) and notes that a locally-admitted submission that has not yet settled keeps `streaming` across empty or absent observations until it settles. The reload fix covers submissions already represented by conversation messages; a submission admitted but not yet materialized into a message at reload time is documented as a residual window.
