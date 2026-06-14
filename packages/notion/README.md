# `@flue/notion`

Verified Notion webhook ingress for Flue.

The package exposes one fixed `POST /webhook` route. It handles Notion's
initial unsigned setup token separately, then verifies exact request bytes with
HMAC-SHA256 before calling application code for recurring events.

```ts
import { createNotionChannel } from '@flue/notion';

export const channel = createNotionChannel({
  verificationToken: process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN!,

  // Path: /channels/notion/webhook
  webhook({ event }) {
    switch (event.type) {
      case 'page.created':
      case 'page.content_updated':
        // Dispatch application work.
        return;
      default:
        return;
    }
  },
});
```

Place this export in `channels/notion.ts`. Flue discovers it and serves
`POST /channels/notion/webhook` relative to the `flue()` mount.

During initial endpoint setup, temporarily provide `verification(...)` to
capture Notion's unsigned token. Store it as
`NOTION_WEBHOOK_VERIFICATION_TOKEN`, restart the application, and paste the
same token into Notion's connection UI.

`event` is the official SDK's provider-native webhook payload union, so
`switch (event.type)` narrows each modeled variant. The only adjustment is
widening `authors`/`accessible_by` to Notion's documented `agent` principal
type, which the current SDK type omits. A verified event whose `type` is newer
than the installed SDK is still forwarded — typed as the union — and reached
from a `default` arm. Outbound API calls, OAuth, subscriptions, credentials,
deduplication, ordering, and persistence remain application-owned.

The package declares `@types/node` as a peer because the official SDK's public
types import `node:http`. This is a declaration-only requirement and does not
add Node runtime code to a Worker bundle.
