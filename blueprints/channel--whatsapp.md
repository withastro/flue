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
`<root>/`. Inspect existing agents, environment types, secret conventions, and
which WhatsApp message families the application handles.

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

## Create the channel

Create `<source-dir>/channels/whatsapp.ts`. Adapt the imported agent,
dispatched input, handled events, and tool:

```ts
// flue-blueprint: channel/whatsapp@1
import {
  createWhatsAppChannel,
  type WebhookMessage,
  type WebhookValue,
  type WhatsAppConversationRef,
} from '@flue/whatsapp';
import { defineTool, dispatch } from '@flue/runtime';
import {
  WhatsAppClient,
  type SendMessageResponse,
} from '@kapso/whatsapp-cloud-api';
import assistant from '../agents/assistant.ts';

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
          await dispatch(assistant, {
            id: channel.conversationKey(
              conversationRef(entry.id, change.value, message),
            ),
            input: {
              type: `whatsapp.${message.type}`,
              messageId: message.id,
              message,
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

function sendTextMessage(
  ref: WhatsAppConversationRef,
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

export function postMessage(ref: WhatsAppConversationRef) {
  return defineTool({
    name: 'post_whatsapp_message',
    description: 'Post to the WhatsApp conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1, maxLength: 4096 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const result = await sendTextMessage(ref, text);
      return JSON.stringify({ messageId: result.messages[0]?.id });
    },
  });
}
```

Use the current Graph API version supported by the project. `v25.0` is current
when this blueprint was authored; keep version upgrades explicit and tested.

## Wire the agent

```ts
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/whatsapp.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

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
configure this callback URL and token:

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
- phone, BSUID, and group conversation-key round trips without namespace
  collisions;
- real SDK helper and low-level BSUID requests against an injected fake Fetch
  transport in workerd;
- Node and Cloudflare project builds.

Do not contact Meta or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
