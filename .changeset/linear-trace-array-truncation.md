---
'@flue/runtime': patch
---

Make trace content truncation scale linearly for long message arrays. Large traced conversations no longer repeatedly serialize the remaining history while fitting `gen_ai.input.messages` to the attribute budget, avoiding request latency and Cloudflare Durable Object CPU-limit resets.
