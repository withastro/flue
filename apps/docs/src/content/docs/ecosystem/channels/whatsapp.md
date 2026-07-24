---
title: WhatsApp
description: Receive verified WhatsApp Business Cloud deliveries with a project-owned Fetch client.
package:
  name: '@flue/whatsapp'
  href: https://www.npmjs.com/package/@flue/whatsapp
lastReviewedAt: 2026-07-21
---

## Quickstart

Add verified WhatsApp Business Cloud webhook ingress with project-owned outbound WhatsApp access to an existing Flue project with the [WhatsApp](https://developers.facebook.com/docs/whatsapp/cloud-api) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel whatsapp
```

## Overview

The blueprint installs `@flue/whatsapp` and `@kapso/whatsapp-cloud-api`, creates
a source-root `channels/whatsapp.ts` module with named `channel` and
project-owned `client` exports, and modifies the selected agent to bind the
generated message tool.

```ts title="src/channels/whatsapp.ts (abridged)"
import { createWhatsAppChannel } from '@flue/whatsapp';
import { dispatch } from '@flue/runtime';
import { WhatsAppClient } from '@kapso/whatsapp-cloud-api';
import { Assistant } from '../agents/assistant.ts';

export const client = new WhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  graphVersion: 'v25.0',
});

export const channel = createWhatsAppChannel({
  appSecret: process.env.WHATSAPP_APP_SECRET!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,
  async webhook({ payload }) {
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        if (change.value.metadata.phone_number_id !== process.env.WHATSAPP_PHONE_NUMBER_ID)
          continue;
        for (const message of change.value.messages ?? []) {
          if (message.type !== 'text' && message.type !== 'interactive') continue;
          const body =
            message.type === 'text'
              ? message.text.body
              : (message.interactive.button_reply?.title ??
                message.interactive.list_reply?.title ??
                message.interactive.nfm_reply?.body ??
                '');
          const ref = conversationRef(entry.id, change.value, message);
          await dispatch(Assistant, {
            id: channel.instanceId(ref),
            // Recorded once when this event creates the instance; ignored after.
            initialData: {
              phoneNumberId: ref.phoneNumberId,
              destination: ref.type === 'individual' ? ref.destination : undefined,
              groupId: ref.type === 'group' ? ref.groupId : undefined,
              contactName: change.value.contacts?.[0]?.profile?.name,
            },
            message: {
              kind: 'signal',
              type: `whatsapp.${message.type}`,
              body,
              attributes: { messageId: message.id },
            },
          });
        }
      }
    }
  },
});
```

The abridged example omits the generated `conversationRef` helper and outbound
message tool. Once configured, supported messages continue the agent instance
for the verified business-scoped user or group, and the bound client tool replies
to that same destination. The Fetch-based client runs on Node and Cloudflare
Workers with Flue's `nodejs_compat` setting.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as whatsapp } from './channels/whatsapp.ts';

app.route('/channels/whatsapp', whatsapp.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/whatsapp` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

## Configure

| Variable                       | Purpose                                                                      |
| ------------------------------ | ---------------------------------------------------------------------------- |
| `WHATSAPP_APP_SECRET`          | **Required** — Verifies signed inbound webhook bodies.                       |
| `WHATSAPP_VERIFY_TOKEN`        | **Required** — Verifies Meta's callback setup challenge.                     |
| `WHATSAPP_ACCESS_TOKEN`        | **Required** — Authenticates outbound Graph API calls.                       |
| `WHATSAPP_PHONE_NUMBER_ID`     | **Required** — Restricts handling to the configured phone number.            |
| `WHATSAPP_BUSINESS_ACCOUNT_ID` | **Optional** — Restricts handling by business account as application policy. |

It installs `@flue/whatsapp` for verified ingress and
`@kapso/whatsapp-cloud-api` for project-owned Graph API access. `@flue/whatsapp`
requires Node 24 because its selected webhook type package declares that engine
floor. The client is Fetch-based and runs in Node and workerd with Flue's
required `nodejs_compat` configuration.

Set the callback URL to:

```txt
https://example.com/channels/whatsapp/webhook
```

Configure the Meta app with the route above and a random
`WHATSAPP_VERIFY_TOKEN`. Subscribe the WhatsApp Business Account to the
`messages` field.

Meta sends GET requests for `hub.challenge` verification and signs POST bodies
with the app secret in `X-Hub-Signature-256`. The package verifies the exact
bytes, then forwards Meta's provider-native payload unmodified. It does not
filter by business account or phone number; restricting to your configured
phone number (`metadata.phone_number_id`) or business account (`entry[].id`) is
application policy, as the handler below shows.

Use a system-user or business access token for production outbound calls. Keep
Graph API versions explicit and test an upgrade before changing them.

## Channel module

```ts title="src/channels/whatsapp.ts"
import {
  createWhatsAppChannel,
  type WebhookMessage,
  type WebhookValue,
  type WhatsAppConversationRef,
} from '@flue/whatsapp';
import { defineTool, dispatch } from '@flue/runtime';
import { WhatsAppClient, type SendMessageResponse } from '@kapso/whatsapp-cloud-api';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

export const client = new WhatsAppClient({
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  graphVersion: 'v25.0',
});

export const channel = createWhatsAppChannel({
  appSecret: process.env.WHATSAPP_APP_SECRET!,
  verifyToken: process.env.WHATSAPP_VERIFY_TOKEN!,

  // Paths: GET and POST /channels/whatsapp/webhook
  async webhook({ payload }) {
    const expectedPhoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID!;
    for (const entry of payload.entry) {
      for (const change of entry.changes) {
        if (change.field !== 'messages') continue;
        const value = change.value;
        // Filtering authenticated deliveries by phone number is application policy.
        if (value.metadata.phone_number_id !== expectedPhoneNumberId) continue;
        for (const message of value.messages ?? []) {
          if (message.type !== 'text' && message.type !== 'interactive') continue;
          const body =
            message.type === 'text'
              ? message.text.body
              : (message.interactive.button_reply?.title ??
                message.interactive.list_reply?.title ??
                message.interactive.nfm_reply?.body ??
                '');
          const ref = conversationRef(entry.id, value, message);
          await dispatch(Assistant, {
            id: channel.instanceId(ref),
            // Recorded once when this event creates the instance; ignored after.
            initialData: {
              phoneNumberId: ref.phoneNumberId,
              destination: ref.type === 'individual' ? ref.destination : undefined,
              groupId: ref.type === 'group' ? ref.groupId : undefined,
              contactName: value.contacts?.[0]?.profile?.name,
            },
            message: {
              kind: 'signal',
              type: `whatsapp.${message.type}`,
              body,
              attributes: { messageId: message.id },
            },
          });
        }
      }
    }
  },
});

// Derive stable individual identity from the business-scoped user id.
function conversationRef(
  businessAccountId: string,
  value: WebhookValue,
  message: WebhookMessage,
): WhatsAppConversationRef {
  const phoneNumberId = value.metadata.phone_number_id;
  if (message.group_id) {
    return { type: 'group', businessAccountId, phoneNumberId, groupId: message.group_id };
  }
  return {
    type: 'individual',
    businessAccountId,
    phoneNumberId,
    destination: { type: 'user-id', userId: message.from_user_id },
  };
}

// The `WhatsAppConversationRef` fields `sendTextMessage()` actually sends on.
export type WhatsAppSendRef =
  | {
      type: 'individual';
      phoneNumberId: string;
      destination:
        { type: 'phone-number'; phoneNumber: string } | { type: 'user-id'; userId: string };
    }
  | { type: 'group'; phoneNumberId: string; groupId: string };

function sendTextMessage(ref: WhatsAppSendRef, body: string): Promise<SendMessageResponse> {
  if (ref.type === 'group') {
    return client.messages.sendText({
      phoneNumberId: ref.phoneNumberId,
      recipientType: 'group',
      to: ref.groupId,
      body,
    });
  }
  if (ref.destination.type === 'phone-number') {
    return client.messages.sendText({
      phoneNumberId: ref.phoneNumberId,
      recipientType: 'individual',
      to: ref.destination.phoneNumber,
      body,
    });
  }
  return client.request<SendMessageResponse>('POST', `${ref.phoneNumberId}/messages`, {
    body: {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      recipient: ref.destination.userId,
      type: 'text',
      text: { body },
    },
    responseType: 'json',
  });
}

export function postMessage(ref: WhatsAppSendRef) {
  return defineTool({
    name: 'post_whatsapp_message',
    description: 'Post to the WhatsApp conversation bound to this agent.',
    input: v.object({
      text: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    }),
    async run({ data: { text } }) {
      const result = await sendTextMessage(ref, text);
      return { messageId: result.messages[0]?.id ?? null };
    },
  });
}
```

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the conversation's destination facts — the agent reads
them with `useInitialData()` instead of parsing the instance id — plus small
instance-constant context like the contact's display name. Per-message facts
stay on the signal's `attributes`.

## Wire the agent

```ts title="src/agents/assistant.ts"
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage, type WhatsAppSendRef } from '../channels/whatsapp.ts';

const initialData = v.object({
  phoneNumberId: v.string(),
  destination: v.optional(
    v.union([
      v.object({ type: v.literal('phone-number'), phoneNumber: v.string() }),
      v.object({ type: v.literal('user-id'), userId: v.string() }),
    ]),
  ),
  groupId: v.optional(v.string()),
  contactName: v.optional(v.string()),
});

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This agent is created by the WhatsApp channel dispatch.');
  let ref: WhatsAppSendRef;
  if (data.groupId !== undefined) {
    ref = { type: 'group', phoneNumberId: data.phoneNumberId, groupId: data.groupId };
  } else if (data.destination !== undefined) {
    ref = { type: 'individual', phoneNumberId: data.phoneNumberId, destination: data.destination };
  } else {
    throw new Error('WhatsApp instance data is missing a destination.');
  }
  useTool(postMessage(ref));
  const contactName = data.contactName ? ` with ${data.contactName}` : '';
  return `Reply concisely in the bound WhatsApp conversation${contactName}.`;
}

Assistant.initialData = initialData;
```

The agent's `initialData` static validates the dispatched `initialData` when the instance is
created; `useInitialData()` returns the parsed value on every render. Trusted
application code selects the destination; the model selects only message
text. `parseInstanceId()` remains available as an escape hatch for recovering
that destination from the id directly.

## Delivery behavior

One POST can contain many entries, changes, messages, and statuses. The callback
runs once with the complete verified delivery; `payload` is Meta's
provider-native webhook object, forwarded unmodified and typed by the
third-party, community-maintained `@whatsapp-cloudapi/types` package. Walk
`payload.entry[].changes[]` in the order Meta sent them, narrow on
`change.field`, then on `message.type` or `status`, and process every applicable
item before returning.

The `message.type` discriminant covers text, image, audio, video, document,
sticker, location, contacts, interactive button/list/flow replies, legacy
buttons, reactions, order, system, and unsupported messages. Authenticated future
shapes still forward at runtime, but may require an application cast or type
guard until the type package models them. The `status` discriminant preserves
`sent`, `delivered`, `read`, `played`, and `failed`.

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body; a Hono or Fetch `Response` passes through. A thrown handler is
not swallowed and reaches Hono's error handler.

Meta expects a prompt `200` (within a few seconds) or it may mark the webhook
inactive, and it retries non-`200` deliveries with decreasing frequency for up
to seven days, so duplicates are expected. Admit durable work quickly (dispatch,
then return) instead of blocking on slow operations. The channel is stateless
and does not deduplicate; claim message ids in durable application storage
before dispatch when duplicate admission is unacceptable.

## Conversation identity

Meta supplies a Business-Scoped User ID (`from_user_id`) in incoming message
webhooks and may omit or change the sender phone number (`from`) as account
features evolve. The `conversationRef` helper above always uses `from_user_id`
for stable inbound individual identity, even when `from` is present. Group
destinations use the provider `group_id`.

The current SDK release exposes broad Graph API helpers but its high-level text
helper models only `to`. The example keeps the full exported SDK client and
uses its authenticated low-level `request()` method for the documented BSUID
`recipient` shape. Test each relied-on operation against fake Fetch in Node and
workerd.

Native media payloads carry a bearer-authenticated media `id` (and, on newer
API versions, a transient `url`). Treat both as transport credentials: download
media with the project-owned client using the verified id, and avoid forwarding
the raw `payload` or media URLs into model context wholesale.

See the [`@flue/whatsapp` README](https://github.com/withastro/flue/tree/main/packages/whatsapp#readme).
