# @flue/messenger

Verified Facebook Messenger Page ingress for Flue channels.

```ts
import { createMessengerChannel } from '@flue/messenger';

export const channel = createMessengerChannel({
  appSecret: process.env.MESSENGER_APP_SECRET!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  webhook({ payload }) {
    // Handle one verified, potentially batched, provider-native Page payload.
  },
});
```

The package owns verification, exact-body signatures, the provider-native
webhook payload, and canonical conversation identity (scoped to the
configured Page).
Applications own Page access tokens, outbound Graph clients, tools, dispatch
policy, and deduplication.

See the prepared package docs or
<https://flueframework.com/docs/ecosystem/channels/messenger/>.
