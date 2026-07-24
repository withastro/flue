# `@flue/google-chat`

Authenticated Google Chat interaction and Workspace Event ingress for Flue
applications.

```ts
import { createGoogleChatChannel } from '@flue/google-chat';

export const channel = createGoogleChatChannel({
  interactions: {
    authentication: {
      type: 'endpoint-url',
      audience: process.env.GOOGLE_CHAT_APP_URL!,
    },

    async handler({ c, payload }) {
      if (payload.type !== 'MESSAGE') return;
      await handleInteraction(payload);
      return c.json({ text: 'Accepted.' });
    },
  },
});
```

Place this export in `channels/google-chat.ts`. Flue discovers it and serves
`POST /channels/google-chat/interactions` relative to the `flue()` mount.

The direct callback receives `{ c, payload }`, where `payload` preserves the
verified Google Chat JSON field names, nesting, discriminants, and unknown
fields. The package supports endpoint-URL OIDC authentication and the legacy
project-number certificate mode.

An optional `POST /channels/google-chat/events` route receives authenticated
Google Workspace Events through Pub/Sub push. Its callback receives
`{ c, delivery }`, preserving the complete Pub/Sub wrapper, message metadata,
CloudEvent attributes, encoded data, and delivery attempt.

Callbacks may return JSON, a Hono or Fetch `Response`, or nothing for an empty
`200`. Exceptions flow through Hono's normal error handling. Request bodies are
stream-limited to 1 MiB by default and can be configured with `bodyLimit`.

This package does not include an outbound Chat client, credential storage,
Workspace Events subscription management, or model tools. Run
`flue add channel google-chat` to generate editable project code using a narrow
service-account OAuth and Chat REST client.

Instance ids identify Google Chat spaces and optional threads. A thread
must belong to its space. Instance ids are not authorization capabilities. The
package is stateless and does not deduplicate interaction or Pub/Sub event ids.
