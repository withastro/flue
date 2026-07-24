---
title: Google Chat
description: Receive authenticated Google Chat interactions and Workspace Events with a project-owned REST client.
package:
  name: '@flue/google-chat'
  href: https://www.npmjs.com/package/@flue/google-chat
lastReviewedAt: 2026-07-21
---

## Quickstart

Add authenticated interactions, optional Workspace Events, and project-owned outbound messaging to an existing Flue project with the [Google Chat](https://developers.google.com/workspace/chat) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel google-chat
```

## Overview

The blueprint installs `@flue/google-chat` and `jose`. It creates a narrow
service-account Fetch client at `<source-root>/lib/google-chat-client.ts` and
`<source-root>/channels/google-chat.ts` with named `channel`, project-owned
`client`, and message-tool exports, then wires the tool into an agent. The
primary generated path handles direct interactions; authenticated Pub/Sub push
for Workspace Events is an optional section in the same channel module.

```ts title="src/channels/google-chat.ts (abridged)"
import { createGoogleChatChannel } from '@flue/google-chat';
import { dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';
import { createGoogleChatClient } from '../lib/google-chat-client.ts';

export const client = createGoogleChatClient({
  clientEmail: process.env.GOOGLE_CHAT_CLIENT_EMAIL!,
  privateKey: process.env.GOOGLE_CHAT_PRIVATE_KEY!,
});

export const channel = createGoogleChatChannel({
  interactions: {
    authentication: {
      type: 'endpoint-url',
      audience: process.env.GOOGLE_CHAT_APP_URL!,
    },
    async handler({ c, payload }) {
      if (payload.type !== 'MESSAGE') return;
      const ref = conversationFromPayload(payload);
      if (!ref) return;

      await dispatch(Assistant, {
        id: channel.instanceId(ref),
        // Recorded once when this event creates the instance; ignored after.
        initialData: {
          space: ref.space,
          ...(ref.thread === undefined ? {} : { thread: ref.thread }),
        },
        message: {
          kind: 'signal',
          type: `google-chat.${payload.type}`,
          body: payload.message?.argumentText ?? payload.message?.text ?? '',
          attributes: {
            // The message resource name is the deduplication key for retried deliveries.
            ...(payload.message?.name === undefined ? {} : { messageName: payload.message.name }),
            ...(payload.user?.name === undefined ? {} : { userName: payload.user.name }),
            ...(payload.user?.displayName === undefined
              ? {}
              : { userDisplayName: payload.user.displayName }),
          },
        },
      });
      return c.body(null, 200);
    },
  },
});
```

The abridged example omits the `conversationFromPayload()` helper; the complete
helper appears in the interaction example below.

An authenticated message is admitted to the agent bound to its Google Chat
space and thread and acknowledged with `200`; other authenticated interactions receive an
empty successful response. The full generated module validates thread and
space identity and lets the bound agent post a reply through the project-owned
client. Workspace Events add an authenticated `/events` route and preserve the
Pub/Sub wrapper for application-owned decoding and deduplication. Both Node and
Cloudflare targets use standards-based Fetch and Web Crypto.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as googleChat } from './channels/google-chat.ts';

app.route('/channels/google-chat', googleChat.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/google-chat` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

## Configure

| Variable                             | Purpose                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `GOOGLE_CHAT_APP_URL`                | **Required for interaction endpoint-URL authentication** — Exact public interaction endpoint used as the Google OIDC token audience. |
| `GOOGLE_CHAT_PUBSUB_SUBSCRIPTION`    | **Required for Workspace Events** — Exact `projects/<project>/subscriptions/<subscription>` resource required in the push body.      |
| `GOOGLE_CHAT_PUBSUB_AUDIENCE`        | **Required for Workspace Events** — Exact audience configured on the authenticated Pub/Sub push subscription.                        |
| `GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT` | **Required for Workspace Events** — Verifies the service-account identity in the Pub/Sub push OIDC token.                            |
| `GOOGLE_CHAT_CLIENT_EMAIL`           | **Required for outbound API calls** — Identifies the service account used to request a `chat.bot` access token.                      |
| `GOOGLE_CHAT_PRIVATE_KEY`            | **Required for outbound API calls** — Signs the service-account JWT assertion used for the OAuth token exchange.                     |

The blueprint installs and configures `@flue/google-chat` for authenticated inbound
requests and `jose` for a project-owned outbound Fetch client. After running the
command, you will have a new `src/channels/google-chat.ts` module exporting
`channel`, `client`, and an application-owned message tool.

Configure only the credentials for the surfaces your application uses.

Set the Google Chat app connection to **HTTP endpoint URL** and use the full
public interaction route:

```txt
https://example.com/channels/google-chat/interactions
```

Set `GOOGLE_CHAT_APP_URL` to that exact URL. With endpoint-URL authentication,
`@flue/google-chat` verifies Google's signature, issuer, expiration, exact
audience, and `chat@system.gserviceaccount.com` identity before invoking the
handler. The package also supports Google's project-number authentication mode;
see the [`@flue/google-chat` README](https://github.com/withastro/flue/tree/main/packages/google-chat#readme) when the Chat app is
configured for that mode.

For Workspace Events, the audience and service-account email must match the
Pub/Sub push subscription's OIDC configuration. The subscription variable must
match the exact subscription resource in every push body.

## Supported Webhooks

| Google surface                                                                                               | Webhook path                         |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------ |
| [Google Chat interaction events](https://developers.google.com/workspace/chat/receive-respond-interactions)  | `/channels/google-chat/interactions` |
| [Google Workspace Events for Google Chat](https://developers.google.com/workspace/events/guides/events-chat) | `/channels/google-chat/events`       |

Configure only the surfaces your application handles. Omitting `interactions` or
`workspaceEvents` from `createGoogleChatChannel()` omits its route.

### Google Chat interactions

```ts title="src/channels/google-chat.ts"
import { createGoogleChatChannel, type GoogleChatConversationRef } from '@flue/google-chat';
import { dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';

export const channel = createGoogleChatChannel({
  interactions: {
    authentication: {
      type: 'endpoint-url',
      audience: process.env.GOOGLE_CHAT_APP_URL!,
    },
    async handler({ c, payload }) {
      switch (payload.type) {
        case 'MESSAGE':
        case 'APP_COMMAND': {
          const ref = conversationFromPayload(payload);
          if (!ref) return c.body(null, 200);

          await dispatch(Assistant, {
            id: channel.instanceId(ref),
            // Recorded once when this event creates the instance; ignored after.
            initialData: {
              space: ref.space,
              ...(ref.thread === undefined ? {} : { thread: ref.thread }),
            },
            message: {
              kind: 'signal',
              type: `google-chat.${payload.type}`,
              body: payload.message?.argumentText ?? payload.message?.text ?? '',
              attributes: {
                // The message resource name is the deduplication key for retried deliveries.
                ...(payload.message?.name === undefined
                  ? {}
                  : { messageName: payload.message.name }),
                ...(payload.user?.name === undefined ? {} : { userName: payload.user.name }),
                ...(payload.user?.displayName === undefined
                  ? {}
                  : { userDisplayName: payload.user.displayName }),
              },
            },
          });
          return c.body(null, 200);
        }
        default:
          return c.body(null, 200);
      }
    },
  },
});

function conversationFromPayload(payload: {
  space?: {
    name?: string;
    spaceType?: GoogleChatConversationRef['spaceType'];
  };
  message?: {
    space?: {
      name?: string;
      spaceType?: GoogleChatConversationRef['spaceType'];
    };
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
```

The callback receives `{ c, payload }`. `payload` preserves Google Chat's native
field names and uppercase discriminants such as `MESSAGE`, `ADDED_TO_SPACE`,
`CARD_CLICKED`, and `APP_COMMAND`. Authenticated future types pass through
without conversion, so the handler decides which interactions affect the
application.

Derive the canonical space from `payload.space.name` or
`payload.message.space.name`. Use `space.spaceType` for descriptive metadata,
not the deprecated `space.type`, and accept a thread only when its resource name
belongs to that exact space. Instance ids are identifiers, not
authorization capabilities; see the shared [Channels guide](/docs/guide/channels/)
for dispatch and authorization guidance.

Google Chat requires the direct endpoint to respond within 30 seconds. The
channel awaits the handler and does not race it against a timeout that would
leave uncancelled work running. Keep admission short, dispatch durable work
promptly, and return nothing or an explicit `200`. JSON-compatible return values
become Google Chat response bodies, while `c` can create an explicit Hono
response.

### Workspace Events

Direct interactions cover activity addressed to the Chat app. Use a Google
Workspace Events subscription backed by an authenticated Pub/Sub push
subscription for broader space activity such as messages, reactions,
memberships, and space updates.

```ts title="src/channels/google-chat.ts"
export const channel = createGoogleChatChannel({
  workspaceEvents: {
    authentication: {
      subscription: process.env.GOOGLE_CHAT_PUBSUB_SUBSCRIPTION!,
      audience: process.env.GOOGLE_CHAT_PUBSUB_AUDIENCE!,
      serviceAccountEmail: process.env.GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT!,
    },
    async handler({ c, delivery }) {
      const bytes = Uint8Array.from(atob(delivery.message.data), (value) => value.charCodeAt(0));
      const event: unknown = JSON.parse(new TextDecoder().decode(bytes));

      await handleWorkspaceEvent({
        event,
        attributes: delivery.message.attributes,
        messageId: delivery.message.messageId,
      });
      return c.body(null, 200);
    },
  },
});
```

The callback receives `{ c, delivery }`, preserving the complete Pub/Sub push
wrapper. CloudEvent attributes remain in `delivery.message.attributes` and the
`application/json` event remains a base64-encoded string in
`delivery.message.data`. Decode the base64 bytes and then parse their UTF-8 JSON
in application code, as shown above; the channel validates the envelope but
does not replace it with a normalized event.

Workspace Event subscriptions expire and can be suspended. Subscription
lifecycle deliveries reach the same callback so application code can renew or
repair the affected subscription. Creating and renewing subscriptions, storing
their state, and any domain-wide delegation or user impersonation remain
application concerns.

## Outbound REST

Outbound Google Chat operations belong to the generated project-owned Fetch
client, not `@flue/google-chat`:

```ts title="src/channels/google-chat.ts"
import { createGoogleChatClient } from '../lib/google-chat-client.ts';

export const client = createGoogleChatClient({
  clientEmail: process.env.GOOGLE_CHAT_CLIENT_EMAIL!,
  privateKey: process.env.GOOGLE_CHAT_PRIVATE_KEY!,
});
```

The client signs a short-lived service-account assertion, exchanges it for a
`chat.bot` access token, caches that token, and posts through the Google Chat
REST API. It validates that a bound thread belongs to the bound space.

## Google Chat Tools

Use the client to define an application-owned tool whose destination and
credentials are bound in trusted code:

```ts title="src/channels/google-chat.ts"
import type { GoogleChatConversationRef } from '@flue/google-chat';
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export function postMessage(ref: GoogleChatConversationRef) {
  return defineTool({
    name: 'post_google_chat_message',
    description: 'Post a message to the Google Chat conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const message = await client.postMessage(ref, text);
      return { message: message.name };
    },
  });
}
```

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. Bind the tool from the agent with `useInitialData()` instead of
parsing the instance id:

```ts title="src/agents/assistant.ts"
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/google-chat.ts';

const initialData = v.object({
  space: v.string(),
  thread: v.optional(v.string()),
});

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This agent is created by the Google Chat channel dispatch.');
  useTool(postMessage(data));
  return 'Reply concisely in the bound Google Chat conversation.';
}

Assistant.initialData = initialData;
```

The agent's `initialData` static validates the dispatched `initialData` when the instance is
created; `useInitialData()` returns the parsed value on every render. The
model selects only message text. It does not select arbitrary service
accounts, spaces, threads, URLs, or REST operations.

## Delivery and runtime behavior

Returning `200` from the Workspace Events handler acknowledges the Pub/Sub push
after the awaited admission work completes. Pub/Sub retries failed or
unacknowledged pushes according to the subscription's delivery policy and
configurable acknowledgement deadline.

Use `delivery.message.messageId` as the Pub/Sub delivery identity. Atomically
claim it in application-owned durable storage before dispatch when duplicate
admission is unacceptable. `delivery.deliveryAttempt` is retry metadata, not a
unique identifier. The channel is stateless and does not deduplicate Pub/Sub
message ids, CloudEvent ids, or direct interactions.

`@flue/google-chat` ingress is tested in Node and workerd using Fetch and Web
Crypto. The generated Fetch client is also exercised in both runtimes for
service-account assertion signing, OAuth token exchange construction, and one
threaded message request against a fail-closed fake transport. Cloudflare builds
use Flue's required `nodejs_compat` setting. Validate any additional outbound
operations your application adds.
