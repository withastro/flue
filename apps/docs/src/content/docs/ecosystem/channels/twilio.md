---
title: Twilio
description: Receive verified Twilio SMS and MMS webhooks with a project-owned Fetch client.
---

## Add Twilio

Run the Twilio recipe through your coding agent:

```sh
flue add twilio --print | codex
```

It installs `@flue/twilio` for verified ingress and creates an editable Fetch
client for outbound Programmable Messaging. The official Twilio Node helper is
not the canonical path because it is Node-only; the generated REST client runs
in Node and workerd with Flue's required `nodejs_compat` configuration.

Set the inbound webhook URL to:

```txt
https://example.com/channels/twilio/webhook
```

## Channel module

```ts title="src/channels/twilio.ts"
import { createTwilioChannel, type TwilioConversationRef } from '@flue/twilio';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { TwilioClient } from '../twilio-client.ts';

export const client = new TwilioClient({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
});

export const channel = createTwilioChannel({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  webhookUrl: process.env.TWILIO_WEBHOOK_URL!,
  destination: {
    type: 'address',
    address: process.env.TWILIO_PHONE_NUMBER!,
  },

  // Path: /channels/twilio/webhook
  async webhook({ payload, conversation }) {
    if (payload.OptOutType === 'STOP') return;
    const numMedia = Number(payload.NumMedia ?? '0');
    await dispatch(assistant, {
      id: channel.conversationKey(conversation),
      input: {
        type: 'twilio.message',
        messageSid: payload.MessageSid,
        from: payload.From,
        text: payload.Body,
        media: Array.from({ length: numMedia }, (_, index) => ({
          index,
          contentType: payload[`MediaContentType${index}`],
        })),
      },
    });
  },
});

export function postMessage(ref: TwilioConversationRef) {
  return defineTool({
    name: 'post_twilio_message',
    description: 'Post to the Twilio conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const result = await client.messages.create({
        to: ref.participant,
        body: text,
        ...(ref.type === 'messaging-service'
          ? { messagingServiceSid: ref.messagingServiceSid }
          : { from: ref.address }),
      });
      return JSON.stringify({ messageSid: result.sid });
    },
  });
}
```

The recipe creates `src/twilio-client.ts` with the Fetch client used above.
Bind the tool from the agent with
`postMessage(channel.parseConversationKey(id))`.

## Configure signatures

Set the account SID, auth token, destination, and exact public webhook URL.
Twilio signs the external configured URL plus every form parameter. An
application behind a proxy cannot reliably reconstruct that URL from the
request, so `webhookUrl` is required and must include any outer mount prefix or
query string.

A trusted proxy may strip an external path prefix before the request reaches
Flue. Signature validation still uses `webhookUrl`; the fixed channel route owns
the internal path. The incoming request's own query string is not re-checked —
it is already part of the signed bytes, so any tampering fails signature
(`401`).

Connection-override fragments may remain in the configured URL. They are
excluded from signature validation because Twilio does not send or sign URL
fragments.

For a Messaging Service, configure:

```ts
destination: {
  type: 'messaging-service',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
},
```

The package rejects signed requests for another account or destination.

## Message behavior

Verified messages reach the handler as `{ c, payload, conversation, idempotencyToken? }`.
`payload` is the provider-native verified form exactly as Twilio signed it: field
names use Twilio's PascalCase wire spelling (`MessageSid`, `From`, `To`, `Body`,
`NumMedia`, `MediaUrl0`, `OptOutType`, …), every value is a `string`, and a
parameter Twilio repeats becomes a `readonly string[]`. The channel does not
rename, narrow, or coerce fields; new parameters Twilio adds reach the handler
through an index signature, so read them directly with their wire names. Parse
segment counts, MMS metadata, opt-out state, geographic, and rich-message fields
in application code. `conversation` is the canonical ref derived from the
verified destination and sender; `idempotencyToken` carries Twilio's
`I-Twilio-Idempotency-Token` when present.

Treat `STOP` as control input rather than dispatching it to an agent or sending
an application reply.

Returning nothing produces an empty TwiML `<Response/>` with status `200`.
Return an ordinary Hono or Fetch `Response` for explicit TwiML, status, or
headers.

MMS URLs require Twilio credentials. Fetch media only in trusted application
code and avoid placing authenticated content or raw forms into model context.

## Delivery status

Add `statusCallbackUrl` and `statusCallback` together to publish:

```txt
https://example.com/channels/twilio/status
```

Set the same URL as `StatusCallback` on outbound messages. The status handler
input mirrors the inbound shape: `payload` carries the exact `MessageStatus` string
forwarded verbatim — never narrowed to a frozen union — alongside every other
signed status parameter (sender, recipient, error, channel, and delivery-receipt
fields), with the same string / `string[]` rules and index-signature forwarding.
`conversation` is present only when both addresses are signed.

Twilio may retry status callbacks with backoff, and may deliver them duplicated
or out of order. Persist transitions idempotently by message SID; the channel is
stateless and exposes `MessageSid` and `I-Twilio-Idempotency-Token` without
claiming durable deduplication.

Twilio does not guarantee `MessagingServiceSid` in every status callback, and
the channel does **not** gate status callbacks on it. For a Messaging Service
channel, the signed account SID and the exact signed callback URL scope the
route. Read `payload.MessagingServiceSid` in application code when a present value
matters.

## Deadlines

Twilio applies a 15-second read timeout to webhook responses and recommends
acknowledging fast and processing asynchronously. The channel does not enforce a
deadline of its own. Inbound message webhooks are **not** retried — on error or
timeout Twilio falls back to the number's configured Fallback URL rather than
re-delivering to this route — so acknowledge before slow work when a missed
inbound matters.

See the [`@flue/twilio` API reference](/docs/api/twilio-channel/).
