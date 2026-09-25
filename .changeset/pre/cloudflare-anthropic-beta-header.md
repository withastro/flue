---
'@flue/runtime': patch
---

Fix Cloudflare-routed Anthropic models (`cloudflare/anthropic/*`) failing with `betas: Extra inputs are not permitted` whenever the agent had tools. Anthropic beta features are now sent in the `anthropic-beta` request header instead of the request body.
