---
{
  "kind": "channel",
  "version": 1,
  "website": "https://resend.com"
}
---

# Add a Resend Channel to Flue

You are an AI coding agent adding verified Resend webhook ingress and
application-owned email behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, receiving-domain setup, and which
Resend email, contact, or domain events the application needs.

Install `@flue/resend` and the official `resend@^6.12.4` SDK with the project's
package manager. Add compatible `@types/node` and `@types/react` development
dependencies because the SDK's public declarations reference `Buffer` and
React email types. Both are declaration-only requirements; they do not add
Node or React runtime code to a Worker bundle.

Flue owns exact-body signature verification and typed ingress. The project owns
receiving domains and MX records, webhook registration, credentials,
deduplication, persistence, retrieving complete email content and attachments,
outbound email, replies, and every model tool.

## Create the channel

Create `<source-dir>/channels/resend.ts`. Adapt the imported agent, dispatched
message, local message identity, and retrieval tool to the application:

```ts
// flue-blueprint: channel/resend@1
import { createResendChannel } from '@flue/resend';
import { defineTool, dispatch, type JsonValue } from '@flue/runtime';
import { Resend } from 'resend';
import { Assistant } from '../agents/assistant.ts';

const EMAIL_INSTANCE_PREFIX = 'resend-email:';

export const client = new Resend(process.env.RESEND_API_KEY!);

export const channel = createResendChannel({
  client,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,

  // Path: /channels/resend/webhook
  async webhook({ event, delivery }) {
    switch (event.type) {
      case 'email.received': {
        await dispatch(Assistant, {
          id: emailInstanceId(event.data.email_id),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            emailId: event.data.email_id,
            from: event.data.from,
            subject: event.data.subject,
            receivedAt: new Date(event.data.created_at).toISOString(),
          },
          message: {
            kind: 'signal',
            type: 'resend.email.received',
            // The webhook carries envelope data only; the agent retrieves the
            // full email text through the retrieve_resend_email tool.
            body: event.data.subject,
            attributes: {
              deliveryId: delivery.id,
              messageId: event.data.message_id,
              to: event.data.to.join(', '),
              ...(event.data.cc.length === 0 ? {} : { cc: event.data.cc.join(', ') }),
              ...(event.data.attachments.length === 0
                ? {}
                : { attachmentCount: String(event.data.attachments.length) }),
            },
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveReceivedEmail(emailId: string) {
  return defineTool({
    name: 'retrieve_resend_email',
    description: 'Retrieve the complete inbound email already bound to this agent.',
    async run() {
      const result = await client.emails.receiving.get(emailId);
      if (result.error) throw new Error(result.error.message);
      return result.data as unknown as JsonValue;
    },
  });
}

export function emailInstanceId(emailId: string): string {
  if (!emailId) throw new TypeError('Resend email id must be non-empty.');
  return `${EMAIL_INSTANCE_PREFIX}${encodeURIComponent(emailId)}`;
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/resend.ts';

const app = new Hono();
app.route('/channels/resend', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/resend` mount; a different mount path shifts every
provider URL accordingly.

The webhook contains message metadata and attachment descriptors, not all body
content. Retrieve the full message later with
`client.emails.receiving.get(emailId)`. When attachment content is needed, use
the project-owned `client.emails.receiving.attachments` API to obtain signed
download URLs, then apply the application's authorization, storage, and
model-context policy.

Do not fetch every inbound body or attachment during webhook handling by
default. Do not add a generic Resend tool collection. Any send, forward, or
reply tool must bind credentials, sender, recipient policy, and the relevant
message in trusted application code rather than accepting arbitrary values from
the model.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the structured envelope facts — the agent reads them with
`useInitialData()` instead of parsing the instance id — plus small
instance-constant context like who the email is from and its subject.
Per-message facts stay on the signal's `attributes`.

## Wire the agent

Bind the trusted inbound email fields inside the agent component:

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveReceivedEmail } from '../channels/resend.ts';

const initialDataSchema = v.object({
  emailId: v.string(),
  from: v.string(),
  subject: v.string(),
  receivedAt: v.pipe(v.string(), v.isoTimestamp()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Resend channel dispatch.');
	useTool(retrieveReceivedEmail(data.emailId));
	return `Review the inbound support email, handling an email from ${data.from} about ${data.subject} received at ${data.receivedAt}. Retrieve the complete email when its body or headers are needed.`;
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

This is an application-defined message-scoped agent instance. `@flue/resend`
does not expose a conversation helper: Resend's `message_id` identifies one
email message, not a stable thread root. If the application groups replies or
related mail, define and persist that thread policy itself.

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and agent function bodies.

## Credentials and endpoint

Configure the webhook URL as the channel's mount path in `app.ts` plus the
route suffix — with the conventional
`app.route('/channels/resend', ...)` mount:

```txt
https://example.com/channels/resend/webhook
```

A different mount path changes the URL accordingly. Subscribe only to
events the application handles.

`RESEND_WEBHOOK_SECRET` verifies inbound deliveries.
`RESEND_API_KEY` authenticates project-owned API calls. They are separate
credentials. Follow the project's secret conventions and never invent values.
Receiving-domain ownership, MX records, webhook creation, signing-secret
rotation, API-key storage, and reply routing remain application concerns.

The callback receives `{ c, event, delivery }`. `event` is the provider-native
payload the official `client.webhooks.verify()` returns, typed as the SDK's
`WebhookEventPayload` union with its original `snake_case` fields. Switch on
`event.type` to narrow to a specific variant. A verified delivery whose `type`
is outside the SDK union is still forwarded with its native `type`,
`created_at`, and `data` fields rather than dropped, so applications can handle
newly introduced provider events.

Resend provides at-least-once delivery and does not guarantee ordering. Use
`delivery.id`, sourced from `svix-id`, as the durable deduplication identity
before dispatch when duplicate admission is unacceptable. The channel does not
persist delivery ids, reorder events, or infer a thread.

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body. A normal Hono or Fetch `Response` passes through unchanged.
Resend retries every status other than `200`, so use a non-`200` response only
when the application intentionally wants redelivery.

## Test without Resend

Run the project's focused typecheck and `vite build` for the configured
target. The SDK and verifier run in Node and workerd with Flue's required
`nodejs_compat` configuration. Use the project's existing credential
convention; both `process.env` and typed Worker bindings are supported.

Use only original synthetic webhook bodies. Generate local signatures over the
exact unchanged body:

1. Choose local `svix-id` and Unix `svix-timestamp` values.
2. Decode the base64 portion of a synthetic `whsec_<base64>` secret.
3. HMAC-SHA256 the UTF-8 string
   `<svix-id>.<svix-timestamp>.<exact-body>`.
4. Set `svix-signature` to `v1,<base64-signature>`.
5. Exercise `POST /channels/resend/webhook` with the official
   `client.webhooks.verify()` path, then prove that changing one body byte,
   signature, id, or timestamp is rejected.

Cover current known events, a future unknown event, missing and stale
signatures, malformed JSON, content type, body limits, `delivery.id`, and
handler result behavior.

Test outbound retrieval through the real `Resend` client with a fake transport.
Construct a test-only client using a local `baseUrl`, replace `globalThis.fetch`
with a stub that rejects every unexpected URL, and assert the expected
`GET /emails/receiving/<email-id>` request and authorization header. Exercise
that fake transport in Node and workerd.

Never create a receiving domain, change MX records, register a webhook, send an
email, retrieve live content, or otherwise contact Resend during implementation
or testing.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
