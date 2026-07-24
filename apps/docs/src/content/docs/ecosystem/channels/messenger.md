---
title: Facebook Messenger
description: Receive verified Messenger Page events with a project-owned Graph API client.
package:
  name: '@flue/messenger'
  href: https://www.npmjs.com/package/@flue/messenger
lastReviewedAt: 2026-07-21
---

## Quickstart

Add verified Page webhook ingress and project-owned outbound Graph API access to an existing Flue project with the [Facebook Messenger](https://developers.facebook.com/docs/messenger-platform) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel messenger
```

## Overview

The Facebook Messenger blueprint installs `@flue/messenger`, creates a project-owned Graph API Fetch client at the source-root `messenger-client.ts`, and creates `channels/messenger.ts`. It also updates the selected agent to bind the generated reply tool to the verified Page conversation.

```ts title="src/channels/messenger.ts (abridged)"
import { createMessengerChannel } from '@flue/messenger';
import { dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';
import { MessengerClient } from '../messenger-client.ts';

export const client = new MessengerClient({
  pageId: process.env.MESSENGER_PAGE_ID!,
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  graphVersion: 'v25.0',
});

export const channel = createMessengerChannel({
  appSecret: process.env.MESSENGER_APP_SECRET!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
  pageId: process.env.MESSENGER_PAGE_ID!,
  async webhook({ payload }) {
    for (const entry of payload.entry) {
      for (const event of entry.messaging ?? []) {
        if (event.message === undefined || event.message.is_echo) continue;
        const conversation = channel.conversationRef(event);
        if (!conversation || event.message.text === undefined) continue;
        const attachmentTypes = (event.message.attachments ?? []).map(
          (attachment) => attachment.type,
        );
        await dispatch(Assistant, {
          id: channel.instanceId(conversation),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            pageId: conversation.pageId,
            participant: conversation.participant,
          },
          message: {
            kind: 'signal',
            type: 'messenger.message',
            body: event.message.text,
            attributes: {
              messageId: event.message.mid,
              ...(event.message.quick_reply?.payload === undefined
                ? {}
                : { quickReplyPayload: event.message.quick_reply.payload }),
              ...(attachmentTypes.length === 0
                ? {}
                : { attachmentTypes: attachmentTypes.join(',') }),
            },
          },
        });
      }
    }
  },
});
```

The abridged example omits the generated `postMessage()` tool and Graph client implementation. Only verified, non-echo text messages from `entry.messaging` are dispatched to the corresponding agent instance; replies return to the same participant through the tool bound by the complete blueprint. Other event families and Graph API operations remain subject to application policy, and the standards-based client supports Node and workerd.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as messenger } from './channels/messenger.ts';

app.route('/channels/messenger', messenger.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/messenger` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

## Configure

| Variable                      | Purpose                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `MESSENGER_APP_SECRET`        | **Required** — Verifies signed inbound webhook bodies.                             |
| `MESSENGER_VERIFY_TOKEN`      | **Required** — Verifies Meta's callback setup challenge.                           |
| `MESSENGER_PAGE_ID`           | **Required** — Scopes conversation identity to your Page and binds outbound sends. |
| `MESSENGER_PAGE_ACCESS_TOKEN` | **Required** — Authenticates outbound Graph API calls.                             |

It installs `@flue/messenger` for verified Page ingress and creates an editable
Graph API Fetch client for outbound messages. The same client runs in Node and
workerd with Flue's required `nodejs_compat` configuration.

Configure Meta to use:

```txt
https://example.com/channels/messenger/webhook
```

Set the app secret, your chosen verify token, the fixed Page id, and a Page
access token. The GET route answers Meta's verification challenge. The POST
route validates the exact body with `X-Hub-Signature-256` before parsing any
events.

Connect the app to the Page and subscribe only to the webhook fields the
application handles. A useful starting set is `messages`, `message_echoes`,
`message_edits`, `messaging_postbacks`, `message_reactions`,
`message_deliveries`, `message_reads`, `messaging_optins`, and
`messaging_referrals`.

The app secret is an inbound verification credential. The Page access token is
an outbound Graph credential. Keep both in trusted server configuration.

## Channel module

```ts title="src/channels/messenger.ts"
import { createMessengerChannel, type MessengerConversationRef } from '@flue/messenger';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import { MessengerClient } from '../messenger-client.ts';

export const client = new MessengerClient({
  pageId: process.env.MESSENGER_PAGE_ID!,
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  graphVersion: 'v25.0',
});

export const channel = createMessengerChannel({
  appSecret: process.env.MESSENGER_APP_SECRET!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
  pageId: process.env.MESSENGER_PAGE_ID!,

  // Paths: GET and POST /channels/messenger/webhook
  async webhook({ payload }) {
    for (const entry of payload.entry) {
      for (const event of entry.messaging ?? []) {
        // Echoes of the Page's own sends and other non-message events are
        // left to application policy. Attachment-only messages are skipped;
        // attachments alongside text surface through `attachmentTypes`.
        if (event.message === undefined || event.message.is_echo) continue;
        const conversation = channel.conversationRef(event);
        if (conversation === undefined || event.message.text === undefined) {
          continue;
        }
        const attachmentTypes = (event.message.attachments ?? []).map(
          (attachment) => attachment.type,
        );
        await dispatch(Assistant, {
          id: channel.instanceId(conversation),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            pageId: conversation.pageId,
            participant: conversation.participant,
          },
          message: {
            kind: 'signal',
            type: 'messenger.message',
            body: event.message.text,
            attributes: {
              messageId: event.message.mid,
              ...(event.message.quick_reply?.payload === undefined
                ? {}
                : { quickReplyPayload: event.message.quick_reply.payload }),
              ...(attachmentTypes.length === 0
                ? {}
                : { attachmentTypes: attachmentTypes.join(',') }),
            },
          },
        });
      }
    }
  },
});

export function postMessage(ref: MessengerConversationRef) {
  return defineTool({
    name: 'post_messenger_message',
    description: 'Post to the Messenger conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const result = await client.messages.sendText({
        to: ref.participant,
        text,
      });
      return { messageId: result.messageId };
    },
  });
}
```

The blueprint creates `src/messenger-client.ts` with the Fetch client used above.
`initialData` is the instance's creation data: recorded once when the event creates the
instance and ignored afterward, so the channel passes it on every dispatch. Bind
the tool from the agent with `useInitialData()` instead of parsing the instance
id:

```ts title="src/agents/assistant.ts"
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/messenger.ts';

const initialData = v.object({
  pageId: v.string(),
  participant: v.variant('type', [
    v.object({ type: v.literal('page-scoped-id'), id: v.string() }),
    v.object({ type: v.literal('user-ref'), id: v.string() }),
  ]),
});

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This agent is created by the Messenger channel dispatch.');
  useTool(postMessage(data));
  return 'Reply concisely in the bound Facebook Messenger conversation.';
}

Assistant.initialData = initialData;
```

## Delivery behavior

One signed POST can contain several Page entries and several events. The
callback runs once with the provider-native `payload`. Iterate `payload.entry[]`
and the native `messaging`, `standby`, and `changes` arrays in Meta's delivered
order; the channel does not reshape, filter, or deduplicate them.

The event family is discriminated by **which property is present** — not by a
`type` field — exactly as Meta delivers it. A message has `event.message`, a
postback has `event.postback`, a reaction has `event.reaction`, and so on
through `event.delivery`, `event.read`, `event.optin`, `event.referral`, and
`event.message_edit`. Field names stay snake_case (`mid`, `quick_reply.payload`,
`is_echo`), and unmodeled families and fields forward intact.

`standby` events arrive while another app owns the conversation under the
Handover protocol. Bot and echo filtering (`message.is_echo`) is application
policy: the channel forwards every verified delivery and the application decides
what to admit.

Returning nothing produces Meta's documented `EVENT_RECEIVED` response with
status `200`. Return an ordinary Hono or Fetch `Response` for explicit control.
Meta retries the delivery on any non-2xx response, so complete only admission
work inside the handler and move long-running behavior behind durable dispatch
or application queues. A handler that blocks does not buy more time; rely on
prompt admission plus idempotency rather than an in-handler deadline. Because
retried deliveries can repeat events and reorder after failures, claim stable
message ids before dispatch when duplicate admission is unacceptable.

## Identity and capabilities

Instance ids combine the fixed Page with either a Page-scoped person id
(PSID) or a `user_ref`. Those participant types are not interchangeable.
`channel.conversationRef(event)` derives the counterpart participant for a
native messaging event; parse or derive the instance id in trusted code and
bind the destination to application-owned tools rather than letting the model
choose a recipient id.

Messaging-opt-in (`event.optin`) events may expose a
`notification_messages_token` — the recurring-notification capability that pairs
with Meta's one-time and recurring notification (OTN) surfaces. Treat it as a
short-lived provider capability and keep it, along with complete native
payloads, out of the dispatched message, model context, logs, and durable
session history.

## Outbound behavior

The generated client exposes a generic Graph request method plus message and
sender-action helpers. Add rich templates, attachments, reactions, typing, or
other operations in project code as needed.

Messenger policy still applies. Ordinary replies use the standard 24-hour
messaging window; message tags, the one-time and recurring notification (OTN)
surfaces, and other outbound paths have separate permission and content
requirements. Sending outside the 24-hour window requires an eligible tag or
notification token.

Messenger does not provide historical webhook notifications. Store the events
your application needs rather than treating process memory as provider
history.

See the
[`@flue/messenger` README](https://github.com/withastro/flue/tree/main/packages/messenger#readme).
