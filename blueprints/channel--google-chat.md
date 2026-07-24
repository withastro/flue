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
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and which Google Chat event families
the application needs.

Install `@flue/google-chat` and `jose@^6.2.3`. Do not use `google-auth-library` in the
canonical integration: its current package declares Node support and depends
on Node-oriented authentication and HTTP packages. Use the documented
service-account JWT assertion, OAuth token exchange, and Chat REST protocols
through Fetch so the same code runs on Node and Cloudflare Workers.

Install `valibot` using the project's existing dependency conventions.

## Create the Fetch client

Create `<source-dir>/lib/google-chat-client.ts`. Keep helpers outside the
`channels/` directory so channel modules stay focused on ingress. Implement
and export a narrow `createGoogleChatClient(...)` that:

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
dispatched message, event policy, and tool:

```ts
// flue-blueprint: channel/google-chat@1
import { createGoogleChatChannel, type GoogleChatConversationRef } from '@flue/google-chat';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
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
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      const message = await client.postMessage(ref, text);
      return { message: message.name };
    },
  });
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/google-chat.ts';

const app = new Hono();
app.route('/channels/google-chat', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/google-chat` mount; a different mount path shifts
every provider URL accordingly.

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

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the space and thread resource names — the agent reads
them with `useInitialData()` instead of parsing the instance id. Per-message
facts stay on the signal's `attributes`.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/google-chat.ts';

const initialDataSchema = v.object({
	space: v.string(),
	thread: v.optional(v.string()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Google Chat channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Google Chat conversation.';
}

Assistant.initialData = initialDataSchema;
```

The `initialData` static validates the dispatched `initialData` when the
instance is created; `useInitialData()` returns the parsed value on every
render.

The `'use agent'` directive (the module's first statement) is what registers
the agent with the application — `dispatch(...)` from the channel callback
needs no `app.ts` mounting. Add
`app.route('/agents/<name>', createAgentRouter(Assistant))` (from
`@flue/runtime/routing`) in `app.ts` only when the agent
should also be reachable over HTTP directly.

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and agent function bodies.

## Credentials and verification

Set the Google Chat app connection to **HTTP endpoint URL** and configure the
channel's mount path in `app.ts` plus the route suffix — with the conventional
`app.route('/channels/google-chat', ...)` mount:

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

Run the project typecheck and `vite build` for the configured target. Generate
local RSA keys and signed OIDC or Chat service tokens. Test valid and invalid
audience, issuer, expiry, signing key, token identity, event subject, body
shape, and response behavior. Exercise service-account assertion signing,
OAuth exchange construction, thread/space mismatch rejection, and one outbound
message against an injected fake Fetch transport in both Node and workerd. Make
the fake fail on every unexpected URL so no test can contact Google services.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
