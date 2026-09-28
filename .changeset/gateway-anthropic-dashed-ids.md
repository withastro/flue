---
'@flue/runtime': patch
---

Fix Claude models on the `cloudflare-ai-gateway` provider failing with `404 not_found_error: model: claude-sonnet-4.6 was not found`. Since Pi 0.84.3 the gateway catalog lists Claude models with dotted versions (`claude-sonnet-4.6`), but the gateway's native Anthropic endpoint forwards the model ID to Anthropic, which only accepts dashed IDs. Flue now registers these models under Anthropic's IDs (`cloudflare-ai-gateway/claude-sonnet-4-6`); dotted specifiers still resolve to them. The `cloudflare` binding provider, which uses Cloudflare's dotted catalog names, is unchanged.
