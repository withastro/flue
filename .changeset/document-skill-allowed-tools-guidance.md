---
'@flue/cli': patch
'@flue/runtime': patch
'@flue/sdk': patch
---

Clarify that a skill's `allowed-tools` field is guidance. Flue accepts it for Agent Skills spec compatibility and does not enforce it; enforce authorization in your own tools and approval gates.
