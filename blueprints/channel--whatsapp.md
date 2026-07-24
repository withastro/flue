---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developers.facebook.com/docs/whatsapp/cloud-api"
}
---

# Add a WhatsApp Channel to Flue

You are an AI coding agent adding verified WhatsApp Business Cloud webhook
ingress with project-owned outbound WhatsApp access to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and which WhatsApp message families the
application handles.

Install `@flue/whatsapp` and `@kapso/whatsapp-cloud-api@^0.2.1`. Flue owns GET
verification, exact-body POST signature verification, and forwarding Meta's
provider-native webhook payload unmodified. The project owns interpreting that
payload, filtering deliveries by business account or phone number, the access
token, the full outbound client, tools, dispatch policy, and durable
deduplication.

The SDK root export is Fetch-based and executes in Node and workerd with
Flue's required `nodejs_compat` configuration. Do not import its `/server`
subpath for ordinary messaging. Keep a workerd fake-transport test for every
client operation the project relies on.

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/whatsapp.ts`. Adapt the imported agent,
dispatched message, handled events, and tool:

```ts
// flue-blueprint: channel/whatsapp@1
import {
  createWhatsAppChannel,
  type WebhookMessage,
  type WebhookValue,
  type WhatsAppConversationRef,
} from '@flue/whatsapp';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import {
  WhatsAppClient,
  type SendMessageResponse,
} from '@kapso/whatsapp-cloud-api';
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
        // Filtering authenticated deliveries by phone number is application policy.
        if (change.value.metadata.phone_number_id !== expectedPhoneNumberId) continue;
        for (const message of change.value.messages ?? []) {
          if (message.type !== 'text' && message.type !== 'interactive') {
            continue;
          }
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

// Derive stable inbound identity from Meta's business-scoped user id. Phone-number
// destinations remain supported for explicitly constructed outbound references.
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
        | { type: 'phone-number'; phoneNumber: string }
        | { type: 'user-id'; userId: string };
    }
  | { type: 'group'; phoneNumberId: string; groupId: string };

function sendTextMessage(
  ref: WhatsAppSendRef,
  body: string,
): Promise<SendMessageResponse> {
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
    async run({ data }) {
      const { text } = data;
      const result = await sendTextMessage(ref, text);
      const messageId = result.messages[0]?.id;
      return { ...(messageId === undefined ? {} : { messageId }) };
    },
  });
}
```

Use the current Graph API version supported by the project. `v25.0` is current
when this blueprint was authored; keep version upgrades explicit and tested.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/whatsapp.ts';

const app = new Hono();
app.route('/channels/whatsapp', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Paths:` comment in this guide assumes the
conventional `/channels/whatsapp` mount; a different mount path shifts every
provider URL accordingly.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the conversation's destination facts — the agent reads
them with `useInitialData()` instead of parsing the instance id — plus small
instance-constant context like the contact's display name. Per-message facts
stay on the signal's `attributes`.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage, type WhatsAppSendRef } from '../channels/whatsapp.ts';

const initialDataSchema = v.object({
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
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
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

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and agent function bodies.

## Configure Meta

Set:

```txt
WHATSAPP_APP_SECRET=...
WHATSAPP_VERIFY_TOKEN=...
WHATSAPP_BUSINESS_ACCOUNT_ID=...
WHATSAPP_PHONE_NUMBER_ID=...
WHATSAPP_ACCESS_TOKEN=...
```

Generate `WHATSAPP_VERIFY_TOKEN` independently. In the Meta app dashboard,
configure this callback URL and token — the channel's mount path in `app.ts`
plus the route suffix, with the conventional
`app.route('/channels/whatsapp', ...)` mount:

```txt
https://example.com/channels/whatsapp/webhook
```

Subscribe the WhatsApp Business Account to the `messages` webhook field. Meta
uses GET on the route for `hub.challenge` verification and POST for JSON
deliveries signed through `X-Hub-Signature-256`.

The package verifies the exact POST bytes before parsing and forwards Meta's
provider-native payload unmodified. It does not filter by business account or
phone number; restricting to your configured `WHATSAPP_PHONE_NUMBER_ID` (and, if
needed, the `entry[].id` business account) is application policy, as the webhook
handler above shows. Do not expose the app secret, verify token, or access token
to the model.

## Handle deliveries

One POST may contain multiple entries, changes, messages, and statuses.
`payload` is Meta's provider-native webhook object, forwarded unmodified and
typed by the third-party, community-maintained `@whatsapp-cloudapi/types`
package. The callback is invoked once for the complete verified delivery; walk
`payload.entry[].changes[]`, narrow on `change.field` and `message.type`, and
process every applicable item before returning success.

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body. Return a normal Hono or Fetch `Response` for explicit status
control. A thrown handler is not swallowed; it reaches Hono's error handler.

Meta expects a prompt `200` (within a few seconds) or it may mark the webhook
inactive, and it retries non-`200` deliveries with decreasing frequency for up
to seven days, so duplicates are expected. Admit durable work quickly (dispatch,
then return) instead of blocking on slow operations. The package is stateless
and forwards the message `id` and event positions without claiming
deduplication. Claim durable ids before dispatch when duplicate admission is
unacceptable.

The `message.type` discriminant covers text, image, audio, video, document,
sticker, location, contacts, interactive button/list/flow replies, legacy
buttons, reactions, order, system, and unsupported messages. Authenticated future
shapes still forward at runtime, but may require an application cast or type
guard until the type package models them. The `status` discriminant preserves
sent, delivered, read, played, and failed states.

## Respect identity boundaries

Meta supplies a Business-Scoped User ID (`from_user_id`) on every incoming
message and may omit the sender phone number (`from`) once the user adopts a
username. The `conversationRef` helper always uses the BSUID for stable inbound
individual identity, so the outbound request uses the matching `recipient`
field. Phone-number destinations remain supported for explicitly constructed
outbound references. Group identity uses the provider's `group_id`.

The SDK's current high-level text helper models `to` but not the documented
BSUID `recipient` field. Keep the full exported SDK client and use its
authenticated low-level `request()` method for that one application-owned
operation. Do not add outbound behavior to `@flue/whatsapp`.

Native media payloads carry a bearer-authenticated media `id` (and, on newer
API versions, a transient `url`). Treat those as transport credentials: use the
verified media id with the project-owned client to download media, and do not
forward the raw `payload` or media URLs into model context wholesale.

## Test without Meta

Create original synthetic payloads from the current official schemas and cover:

- GET challenge success, changed tokens, and duplicate query parameters;
- exact-body HMAC verification with changed bytes and Unicode;
- application-side phone-number filtering of authenticated deliveries;
- multiple entries, changes, messages, statuses, and non-`messages` fields;
- phone-only, BSUID-only, and combined identity payloads, including parent
  BSUIDs and omitted phone fields;
- text, media, location, contacts, interactive replies, reactions,
  unsupported messages, and unknown future message types forwarded natively;
- malformed JSON, content type, body limits, and response behavior;
- phone, BSUID, and group instance-id round trips without namespace
  collisions;
- real SDK helper and low-level BSUID requests against an injected fake Fetch
  transport in workerd;
- the project typecheck and `vite build` for the configured target.

Do not contact Meta or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
