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
`<root>/`. Inspect existing agents, environment types, secret conventions,
receiving-domain setup, and which Resend email, contact, or domain events the
application needs.

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
input, local message identity, and retrieval tool to the application:

```ts
// flue-blueprint: channel/resend@1
import { createResendChannel } from '@flue/resend';
import { defineTool, dispatch } from '@flue/runtime';
import { Resend } from 'resend';
import assistant from '../agents/assistant.ts';

const EMAIL_INSTANCE_PREFIX = 'resend-email:';

export const client = new Resend(process.env.RESEND_API_KEY!);

export const channel = createResendChannel({
  client,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,

  // Path: /channels/resend/webhook
  async webhook({ event, delivery }) {
    switch (event.type) {
      case 'email.received': {
        await dispatch(assistant, {
          id: emailInstanceId(event.data.email_id),
          input: {
            type: 'resend.email.received',
            deliveryId: delivery.id,
            emailId: event.data.email_id,
            messageId: event.data.message_id,
            from: event.data.from,
            to: event.data.to,
            cc: event.data.cc,
            subject: event.data.subject,
            attachments: event.data.attachments,
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
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result = await client.emails.receiving.get(emailId);
      if (result.error) throw new Error(result.error.message);
      return JSON.stringify(result.data);
    },
  });
}

export function emailInstanceId(emailId: string): string {
  if (!emailId) throw new TypeError('Resend email id must be non-empty.');
  return `${EMAIL_INSTANCE_PREFIX}${encodeURIComponent(emailId)}`;
}

export function emailIdFromInstanceId(id: string): string {
  if (!id.startsWith(EMAIL_INSTANCE_PREFIX)) {
    throw new TypeError('Expected a local Resend email instance id.');
  }
  const emailId = decodeURIComponent(id.slice(EMAIL_INSTANCE_PREFIX.length));
  if (!emailId) throw new TypeError('Expected a local Resend email instance id.');
  return emailId;
}
```

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

## Wire the agent

Bind the trusted inbound email id inside the agent initializer:

```ts
import { defineAgent } from '@flue/runtime';
import {
  emailIdFromInstanceId,
  retrieveReceivedEmail,
} from '../channels/resend.ts';

export default defineAgent(({ id }) => {
  const emailId = emailIdFromInstanceId(id);
  return {
    model: 'anthropic/claude-haiku-4-5',
    tools: [retrieveReceivedEmail(emailId)],
  };
});
```

This is an application-defined message-scoped agent instance. `@flue/resend`
does not expose a conversation helper: Resend's `message_id` identifies one
email message, not a stable thread root. If the application groups replies or
related mail, define and persist that thread policy itself.

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Credentials and endpoint

Configure the webhook URL as:

```txt
https://example.com/channels/resend/webhook
```

If `flue()` is mounted beneath an outer prefix, include it. Subscribe only to
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

Run the project's focused typecheck and configured Node and Cloudflare checks.
The SDK and verifier run in Node and workerd with Flue's required
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
