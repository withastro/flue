---
{
  "kind": "channel",
  "version": 1,
  "website": "https://www.twilio.com/docs/messaging"
}
---

# Add a Twilio Messaging Channel to Flue

You are an AI coding agent adding verified Twilio SMS and MMS webhook ingress
with project-owned outbound Twilio access to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and whether the project uses one Twilio
address or a Messaging Service.

Install `@flue/twilio` and `twilio@^6.0.2`. Flue owns signed webhook validation,
exact public-URL handling, fixed account and destination identity, provider-native verified form
fields, optional delivery-status callbacks, TwiML acknowledgement, and canonical
instance ids. The project owns credentials, outbound REST access, tools,
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

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/twilio.ts`. Adapt the imported agent, dispatched
message, destination mode, and tool:

```ts
// flue-blueprint: channel/twilio@1
import { createTwilioChannel } from '@flue/twilio';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
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
    const attributes: Record<string, string> = {
      messageSid: payload.MessageSid,
      from: payload.From,
    };
    const numMedia = Number(payload.NumMedia ?? '0');
    if (numMedia > 0) {
      attributes.numMedia = String(numMedia);
      for (let index = 0; index < numMedia; index += 1) {
        const contentType = payload[`MediaContentType${index}`];
        if (typeof contentType === 'string') {
          attributes[`mediaContentType${index}`] = contentType;
        }
      }
    }
    await dispatch(Assistant, {
      id: channel.instanceId(conversation),
      // Recorded once when this event creates the instance; ignored after.
      initialData:
        conversation.type === 'messaging-service'
          ? {
              type: conversation.type,
              messagingServiceSid: conversation.messagingServiceSid,
              participant: conversation.participant,
            }
          : {
              type: conversation.type,
              address: conversation.address,
              participant: conversation.participant,
            },
      message: {
        kind: 'signal',
        type: 'twilio.message',
        body: payload.Body,
        attributes,
      },
    });
  },
});

export function postMessage(
  ref:
    | { type: 'address'; address: string; participant: string }
    | { type: 'messaging-service'; messagingServiceSid: string; participant: string },
) {
  return defineTool({
    name: 'post_twilio_message',
    description: 'Post to the Twilio conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      const result = await client.messages.create({
        to: ref.participant,
        body: text,
        ...(ref.type === 'messaging-service'
          ? { messagingServiceSid: ref.messagingServiceSid }
          : { from: ref.address }),
      });
      return { messageSid: result.sid };
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

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/twilio.ts';

const app = new Hono();
app.route('/channels/twilio', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/twilio` mount; a different mount path shifts every
provider URL accordingly.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the conversation ref fields the reply tool needs — the
agent reads them with `useInitialData()` instead of parsing the instance id.
Per-message facts stay on the signal's `attributes`.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/twilio.ts';

const initialDataSchema = v.variant('type', [
	v.object({ type: v.literal('address'), address: v.string(), participant: v.string() }),
	v.object({
		type: v.literal('messaging-service'),
		messagingServiceSid: v.string(),
		participant: v.string(),
	}),
]);

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Twilio channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Twilio conversation.';
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

## Configure Twilio

Set:

```txt
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_PHONE_NUMBER=...
TWILIO_WEBHOOK_URL=https://example.com/channels/twilio/webhook
```

Configure the phone number or Messaging Service inbound webhook to send `POST`
requests to the exact `TWILIO_WEBHOOK_URL` value. The URL is the channel's
mount path in `app.ts` plus the route suffix (shown with the conventional
`app.route('/channels/twilio', ...)` mount) and must include any query
string. Twilio signs the external
configured URL and form fields in `X-Twilio-Signature`, so do not derive this
value from the incoming request behind a proxy.

The external path may differ from the internal request path when a trusted
proxy strips a prefix. The package validates the signature over the configured
external URL — query string included — while the mounted channel route owns
the internal path. The incoming request's own query string is not re-checked: it is
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
address, or Messaging Service. Instance ids identify the fixed Twilio
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
- canonical instance-id round trips;
- real outbound Fetch requests against local fake transports in Node and
  workerd;
- the project typecheck and `vite build` for the configured target.

Do not contact Twilio or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
