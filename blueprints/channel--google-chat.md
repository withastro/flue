---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developers.google.com/workspace/chat"
}
---

# Add a Google Chat Channel to Flue

You are an AI coding agent adding authenticated Google Chat interactions,
optional Google Workspace Events, and project-owned outbound messaging to a
Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
which Google Chat event families the application needs.

Install `@flue/google-chat` and `jose@^6.2.3`. Do not use `google-auth-library` in the
canonical integration: its current package declares Node support and depends
on Node-oriented authentication and HTTP packages. Use the documented
service-account JWT assertion, OAuth token exchange, and Chat REST protocols
through Fetch so the same code runs on Node and Cloudflare Workers.

## Create the Fetch client

Create `<source-dir>/lib/google-chat-client.ts`. Keep helpers outside the
immediate `channels/` directory because every file there is discovered as a
channel module. Implement and export a narrow `createGoogleChatClient(...)`
that:

- imports the service-account PKCS#8 private key with `jose`;
- signs an `RS256` JWT assertion with the service-account email as `iss`,
  `https://oauth2.googleapis.com/token` as `aud`, a one-hour lifetime, and the
  `https://www.googleapis.com/auth/chat.bot` scope;
- exchanges the assertion using
  `urn:ietf:params:oauth:grant-type:jwt-bearer`;
- caches the access token until shortly before `expires_in`;
- posts messages to
  `https://chat.googleapis.com/v1/<space>/messages`;
- includes the trusted thread name and
  `messageReplyOption=REPLY_MESSAGE_OR_FAIL` for a thread reply;
- binds the space and thread from trusted application code rather than model
  arguments;
- uses an injectable Fetch implementation for local and workerd tests.

Validate OAuth and Chat API response status and shape. Never accept an API
base URL, space name, thread name, private key, or service-account email from a
model.

## Create the channel

Create `<source-dir>/channels/google-chat.ts`. Adapt the imported agent,
dispatched input, event policy, and tool:

```ts
// flue-blueprint: channel/google-chat@1
import { createGoogleChatChannel, type GoogleChatConversationRef } from '@flue/google-chat';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createGoogleChatClient } from '../lib/google-chat-client.ts';

const appUrl = process.env.GOOGLE_CHAT_APP_URL!;

export const client = createGoogleChatClient({
  clientEmail: process.env.GOOGLE_CHAT_CLIENT_EMAIL!,
  privateKey: process.env.GOOGLE_CHAT_PRIVATE_KEY!,
});

export const channel = createGoogleChatChannel({
  interactions: {
    authentication: {
      type: 'endpoint-url',
      audience: appUrl,
    },

    // Path: /channels/google-chat/interactions
    async handler({ c, payload }) {
      switch (payload.type) {
        case 'MESSAGE':
        case 'APP_COMMAND': {
          const ref = conversationFromPayload(payload);
          if (!ref) return;
          await dispatch(assistant, {
            id: channel.conversationKey(ref),
            input: {
              type: `google-chat.${payload.type}`,
              user: payload.user,
              payload,
            },
          });
          return c.body(null, 200);
        }
        default:
          return;
      }
    },
  },

  // Optional Path: /channels/google-chat/events
  // workspaceEvents: {
  //   authentication: {
  //     subscription: process.env.GOOGLE_CHAT_PUBSUB_SUBSCRIPTION!,
  //     audience: process.env.GOOGLE_CHAT_PUBSUB_AUDIENCE!,
  //     serviceAccountEmail: process.env.GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT!,
  //   },
  //   async handler({ c, delivery }) {
  //     // Decode delivery.message.data after deduplicating delivery.message.messageId.
  //     return c.body(null, 200);
  //   },
  // },
});

function conversationFromPayload(payload: {
  space?: { name?: string; spaceType?: GoogleChatConversationRef['spaceType'] };
  message?: {
    space?: { name?: string; spaceType?: GoogleChatConversationRef['spaceType'] };
    thread?: { name?: string };
  };
  thread?: { name?: string };
}): GoogleChatConversationRef | undefined {
  const space = payload.space ?? payload.message?.space;
  if (!space?.name || !/^spaces\/[^/]+$/.test(space.name)) return;
  const thread = payload.message?.thread?.name ?? payload.thread?.name;
  if (thread !== undefined) {
    const match = /^(spaces\/[^/]+)\/threads\/[^/]+$/.exec(thread);
    if (!match || match[1] !== space.name) return;
  }
  return {
    space: space.name,
    ...(thread === undefined ? {} : { thread }),
    ...(space.spaceType === undefined ? {} : { spaceType: space.spaceType }),
  };
}

export function postMessage(ref: GoogleChatConversationRef) {
  return defineTool({
    name: 'post_google_chat_message',
    description: 'Post a message to the Google Chat conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const message = await client.postMessage(ref, text);
      return JSON.stringify({ message: message.name });
    },
  });
}
```

Direct callbacks receive `{ c, payload }`. `payload` preserves Google Chat's
native field names and uppercase discriminants such as `MESSAGE`,
`ADDED_TO_SPACE`, `CARD_CLICKED`, and `APP_COMMAND`; future authenticated types
are passed through without conversion. Derive the canonical space from
`payload.space.name` or `payload.message.space.name`, derive descriptive metadata
from `space.spaceType` rather than the deprecated `space.type`, and accept a
thread only when its resource name belongs to that exact space.

Workspace Event callbacks receive `{ c, delivery }`, preserving the complete
Pub/Sub push wrapper. The CloudEvent attributes remain under
`delivery.message.attributes`, and its JSON data remains base64-encoded in
`delivery.message.data` for application-owned decoding.

Returning nothing produces an empty `200`; returning JSON produces the direct
Google Chat response body; return a normal Hono or Fetch `Response` for
explicit status control. Google Chat requires the direct endpoint to respond
within 30 seconds. The package deliberately does not race the callback against
a non-cancelling timeout, so keep admission short and move durable work behind
the dispatch boundary.

## Wire the agent

```ts
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/google-chat.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and initializers.

## Credentials and verification

Set the Google Chat app connection to **HTTP endpoint URL** and configure:

```txt
https://example.com/channels/google-chat/interactions
```

Set `GOOGLE_CHAT_APP_URL` to that exact URL. The package verifies Google's
`RS256` OIDC token, issuer, exact audience, expiration, and
`chat@system.gserviceaccount.com` identity before invoking the handler.

Google Chat also supports the legacy project-number token format. Use
`authentication: { type: 'project-number', projectNumber }` only when the
application is configured for that documented mode.

For all-message delivery, create a Google Workspace Events subscription backed
by a Pub/Sub push subscription with authentication enabled. The `/events`
route requires the standard wrapped Pub/Sub push body; do not unwrap the
CloudEvent before forwarding it. Set the push audience to the exact
`/channels/google-chat/events` URL and configure the same audience and push
service-account email in `workspaceEvents.authentication`. Grant the Google
Chat publishing service account access to the topic as required by Google's
setup documentation.

Set `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION` to the exact
`projects/<project>/subscriptions/<subscription>` push resource. The Pub/Sub
acknowledgement deadline is configurable; set it for the application's admission work. Pub/Sub
retries unacknowledged or failed pushes, and the package does not deduplicate
them: atomically claim `delivery.message.messageId` before dispatch. Treat
`delivery.deliveryAttempt` as retry metadata, not as a unique identity.

`GOOGLE_CHAT_CLIENT_EMAIL` and `GOOGLE_CHAT_PRIVATE_KEY` come from the outbound
service account. Follow the project's secret conventions and never invent
values. Domain-wide delegation and user impersonation are not required for
ordinary app-authenticated posting; add them only for application features
that explicitly require user authentication.

Run the project's typecheck and both Node and Cloudflare builds. Generate local
RSA keys and signed OIDC or Chat service tokens. Test valid and invalid
audience, issuer, expiry, signing key, token identity, event subject, body
shape, and response behavior. Exercise service-account assertion signing,
OAuth exchange construction, thread/space mismatch rejection, and one outbound
message against an injected fake Fetch transport in both Node and workerd. Make
the fake fail on every unexpected URL so no test can contact Google services.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
