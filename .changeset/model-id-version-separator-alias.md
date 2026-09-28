---
'@flue/runtime': patch
---

Fix model specifiers that stopped resolving after the Pi 0.87.1 upgrade. Pi renamed the `cloudflare-ai-gateway` Claude model IDs from dashed versions to dotted versions (`claude-sonnet-4-6` → `claude-sonnet-4.6`), so existing specifiers such as `cloudflare-ai-gateway/claude-sonnet-4-6` failed with `Unknown model ID`. When a model ID isn't in the catalog but matches exactly one catalog ID that differs only in `-` versus `.` between version digits, Flue now resolves to that model and logs a one-time warning suggesting the current ID.
