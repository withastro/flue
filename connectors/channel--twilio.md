---
{
  "category": "channel",
  "website": "https://www.twilio.com/docs/messaging"
}
---

# Add a Twilio Messaging Channel to Flue

You are an AI coding agent adding verified Twilio SMS and MMS webhook ingress
with project-owned outbound Twilio access to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
whether the project uses one Twilio address or a Messaging Service.

Install `@flue/twilio`. Flue owns signed webhook validation, exact public-URL
handling, fixed account and destination identity, provider-native verified form
fields, optional delivery-status callbacks, TwiML acknowledgement, and canonical
conversation keys. The project owns credentials, outbound REST access, tools,
dispatch policy, and durable duplicate admission.

Do not install the official `twilio` Node helper in a Cloudflare project. Its
current package declares Node 20, has no edge export, and imports Node-oriented
HTTP, proxy, JWT, query-string, and XML dependencies. Use a small
standards-based Fetch client in project code. Keep Node and workerd tests for
every operation the application relies on.

## Create a Fetch client

Create `<source-dir>/twilio-client.ts`. Implement a project-owned
`TwilioClient` with:

- `accountSid`, `authToken`, optional `fetch`, and optional `apiBaseUrl`
  constructor options;
- `client.messages.create(...)`;
- `POST
  /2010-04-01/Accounts/{AccountSid}/Messages.json`;
- HTTP Basic authentication using the account SID and auth token;
- `application/x-www-form-urlencoded` fields including `To`, exactly one of
  `From` or `MessagingServiceSid`, optional `Body`, repeated `MediaUrl`, and
  optional `StatusCallback`;
- non-2xx error handling and a typed result exposing at least `sid` and
  optional `status`.

Use global `fetch`, `URLSearchParams`, and `btoa`. Do not add Node-only
polyfills. The repository example at `examples/twilio-channel/` shows the
expected project-owned shape, but adapt it to the project's actual operations.

## Create the channel

Create `<source-dir>/channels/twilio.ts`. Adapt the imported agent, dispatched
input, destination mode, and tool:

```ts
import {
  createTwilioChannel,
  type TwilioConversationRef,
} from '@flue/twilio';
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

For a Messaging Service, replace `destination` with:

```ts
destination: {
  type: 'messaging-service',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
},
```

## Wire the agent

```ts
import { createAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/twilio.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Configure Twilio

Set:

```txt
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
TWILIO_WEBHOOK_URL=https://example.com/channels/twilio/webhook
```

Configure the phone number or Messaging Service inbound webhook to send `POST`
requests to the exact `TWILIO_WEBHOOK_URL` value. The URL must include any
outer `flue()` mount prefix and any query string. Twilio signs the external
configured URL and form fields in `X-Twilio-Signature`, so do not derive this
value from the incoming request behind a proxy.

The external path may differ from the internal request path when a trusted
proxy strips a prefix. The package validates the signature over the configured
external URL — query string included — while Flue's fixed route owns the
internal path. The incoming request's own query string is not re-checked: it is
already covered by the signed bytes, so any tampering fails signature (`401`).

Twilio connection-override fragments such as `#rc=2&rp=all` may remain in the
configured value; Twilio does not include the fragment in the signature or
request URL.

Do not expose the account SID, auth token, or authenticated media fetches to
the model.

## Add status callbacks when needed

Status ingress is optional. Add both properties together:

```ts
statusCallbackUrl: process.env.TWILIO_STATUS_CALLBACK_URL!,

// Path: /channels/twilio/status
async statusCallback({ payload }) {
  // Persist delivery state (payload.MessageStatus) outside model context.
},
```

Set `StatusCallback` on outbound messages to the same exact public URL.
Omitting `statusCallback` means `/status` is not published. Status callbacks
can be duplicated or arrive out of order; persist transitions idempotently by
message SID.

Twilio does not guarantee `MessagingServiceSid` in every status callback. For
a Messaging Service channel, the signed account SID and the exact signed
callback URL scope the route; the package does not gate status callbacks on a
matching `MessagingServiceSid`. Read `payload.MessagingServiceSid` in application
code when a present value matters.

## Handle inbound messages

The handler input is `{ c, payload, conversation, idempotencyToken? }`:

- `payload` is the provider-native verified form using Twilio's PascalCase wire
  names (`MessageSid`, `From`, `To`, `Body`, `NumMedia`, `NumSegments`,
  `MediaUrl0`, `OptOutType`, `Latitude`, geographic, and rich-message fields).
  Every value is a string; a repeated parameter becomes a `string[]`. New Twilio
  parameters are forwarded through an index signature, so read fields directly.
- `conversation` is the canonical conversation ref derived from the verified
  destination and sender.
- `idempotencyToken` is Twilio's `I-Twilio-Idempotency-Token` when present.

The channel does not narrow, rename, or coerce Twilio's fields; parse numbers,
media counts, and opt-out values in application code.

Treat `OptOutType=STOP` as control input and do not dispatch it to an agent or
attempt an application reply. Twilio handles the configured opt-out response
and blocks subsequent sends according to the Messaging Service policy.

Returning nothing produces an empty TwiML `<Response/>` with status `200`.
Return a normal Hono or Fetch `Response` for explicit TwiML, status, or headers.
Do not return JSON to Twilio Messaging webhooks.

Inbound media URLs require Twilio authentication. Fetch them in trusted
application code with the project credentials, and do not dispatch URLs or
downloaded bytes wholesale into model context.

## Respect identity and retries

The package rejects valid signatures for another account, phone/channel
address, or Messaging Service. Conversation keys identify the fixed Twilio
destination plus the external participant; they are not authorization
capabilities.

Twilio can retry failed webhook requests. The package is stateless and exposes
message SIDs and `I-Twilio-Idempotency-Token` without claiming durable
deduplication. Claim message SIDs before dispatch when duplicate admission is
unacceptable.

## Test without Twilio

Create original synthetic form posts from current official schemas and cover:

- signatures generated by the current official helper as an independent Node
  oracle;
- Web Crypto HMAC-SHA1 verification in workerd;
- exact configured public URLs, query strings, and connection fragments;
- changed, missing, and malformed signatures;
- fixed account, address, and Messaging Service identity;
- SMS text, MMS media, Advanced Opt-Out, location, rich metadata, and Unicode;
- duplicate and future form fields;
- optional status callbacks, unknown states, errors, duplicates, and ordering
  policy;
- body limits, content types, malformed fields, TwiML defaults, and explicit
  `Response` control;
- canonical conversation-key round trips;
- real outbound Fetch requests against local fake transports in Node and
  workerd;
- Node and Cloudflare project builds.

Do not contact Twilio or copy third-party fixtures.
