---
'@flue/cli': patch
'@flue/discord': patch
'@flue/github': patch
'@flue/google-chat': patch
'@flue/intercom': patch
'@flue/linear': patch
'@flue/messenger': patch
'@flue/notion': patch
'@flue/resend': patch
'@flue/runtime': patch
'@flue/salesforce': patch
'@flue/shopify': patch
'@flue/slack': patch
'@flue/stripe': patch
'@flue/teams': patch
'@flue/telegram': patch
'@flue/twilio': patch
'@flue/vite': patch
'@flue/whatsapp': patch
'@flue/zendesk': patch
---

Allow Flue packages and newly scaffolded applications to share a compatible Hono installation. Hono dependencies now use `^4.12.32`, preventing fresh projects from installing a newer root Hono alongside the runtime's older exact version and failing typecheck.
