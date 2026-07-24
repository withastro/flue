# `@flue/linear`

Verified Linear webhook ingress for Flue applications.

```ts
import { createLinearChannel } from '@flue/linear';

export const channel = createLinearChannel({
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,

  // Path: /channels/linear/webhook
  async webhook({ payload, deliveryId }) {
    await handleLinearPayload(payload, deliveryId);
  },
});
```

Place this export in `channels/linear.ts`. Flue discovers it and serves
`POST /channels/linear/webhook` relative to the `flue()` mount.

The package verifies the exact request bytes with HMAC-SHA256, rejects webhook
timestamps outside Linear's recommended one-minute window, and optionally
checks fixed organization and webhook ids, and requires a UUID-v4
`Linear-Delivery` header. It then forwards the provider-native
`payload`, typed by Linear's official `LinearWebhookPayload` union (re-exported
from `@linear/sdk/webhooks`), unmodified — including verified deliveries the
union does not model. The application switches on Linear's own `type` and
`action` discriminants and reads Linear's own field names.

This package does not include an outbound Linear client, OAuth installation
storage, or model tools. Run `flue add channel linear` to generate editable project
code using the official `@linear/sdk` client.

Instance ids identify issues, nested issue-comment threads, and agent
sessions. They are not authorization capabilities. The package is stateless
and does not deduplicate `Linear-Delivery` ids.
