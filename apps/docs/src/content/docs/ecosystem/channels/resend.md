---
title: Resend
description: Receive verified Resend webhooks and retrieve inbound email through the official client.
package:
  name: '@flue/resend'
  href: https://www.npmjs.com/package/@flue/resend
lastReviewedAt: 2026-07-21
---

## Quickstart

Add verified webhook ingress and application-owned email behavior to an existing Flue project with the [Resend](https://resend.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel resend
```

## Overview

The Resend blueprint installs `@flue/resend` and the official `resend` SDK, adds the SDK's declaration-only development dependencies, and creates `channels/resend.ts` in the source-root. It also updates the selected agent to bind a message-retrieval tool to the verified inbound email.

```ts title="src/channels/resend.ts (abridged)"
import { createResendChannel } from '@flue/resend';
import { dispatch, useModel } from '@flue/runtime';
import { Resend } from 'resend';
import { Assistant } from '../agents/assistant.ts';

export const client = new Resend(process.env.RESEND_API_KEY!);

export const channel = createResendChannel({
  client,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
  async webhook({ event, delivery }) {
    if (event.type !== 'email.received') return;
    await dispatch(Assistant, {
      id: emailInstanceId(event.data.email_id),
      message: {
        kind: 'signal',
        type: 'resend.email.received',
        // The webhook carries envelope data only; the agent retrieves the
        // full email text through the retrieve_resend_email tool.
        body: event.data.subject,
        attributes: {
          deliveryId: delivery.id,
          emailId: event.data.email_id,
          from: event.data.from,
          to: event.data.to.join(', '),
        },
      },
    });
  },
});
```

The abridged example omits the generated local email-id helpers and `retrieveReceivedEmail()` tool. The complete blueprint binds that tool in the agent module, so a verified `email.received` event starts a message-scoped agent instance that can retrieve the full email through the project-owned client. Receiving-domain setup, webhook registration, attachment retrieval, outbound mail, and reply policy remain application-owned.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as resend } from './channels/resend.ts';

app.route('/channels/resend', resend.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/resend` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

## Configure

| Variable                | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| `RESEND_WEBHOOK_SECRET` | **Required** — Verifies inbound deliveries.      |
| `RESEND_API_KEY`        | **Required** — Authenticates outbound SDK calls. |

It installs `@flue/resend` and the official `resend@6.12.4` SDK. The blueprint
creates a channel module with named `channel` and project-owned `client`
exports.

Configure the webhook URL as:

```txt
https://example.com/channels/resend/webhook
```

The webhook secret and outbound API key are separate credentials.

The SDK's public declarations reference `Buffer` and React email types. Add
`@types/node` and `@types/react` as development dependencies. Both are
declaration-only requirements and add no Node or React runtime code to a Worker
bundle.

## Channel module

```ts title="src/channels/resend.ts"
import { createResendChannel } from '@flue/resend';
import { defineTool, dispatch, useModel } from '@flue/runtime';
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
          message: {
            kind: 'signal',
            type: 'resend.email.received',
            // The webhook carries envelope data only; the agent retrieves the
            // full email text through the retrieve_resend_email tool.
            body: event.data.subject,
            attributes: {
              deliveryId: delivery.id,
              emailId: event.data.email_id,
              messageId: event.data.message_id,
              from: event.data.from,
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
      return result.data;
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

`@flue/resend` gives `client.webhooks.verify()` the exact request body and the
signed `svix-id`, `svix-timestamp`, and `svix-signature` values before invoking
`webhook`. Returning nothing produces an empty `200`. A JSON-compatible value
becomes the response body, and a normal Hono or Fetch `Response` passes through
unchanged. Resend retries every status other than `200`, so return a non-`200`
response only when redelivery is intentional.

Every verified delivery is the official `WebhookEventPayload` union, forwarded
verbatim. Each event keeps its provider-native `event.type`, `created_at`, and
`data` fields, including event types newer than your installed `resend`
version. The channel never wraps events in a `type: 'unknown'` envelope, so
`switch (event.type)` narrows the modeled variants and a `default` branch
handles anything your SDK predates.

## Retrieve message content

The `email.received` webhook includes routing metadata and attachment
descriptors. Retrieve the full body, headers, and current attachment metadata
later through the project-owned client:

```ts
const email = await client.emails.receiving.get(emailId);
```

Use `client.emails.receiving.attachments` to obtain signed download URLs when
attachment content is needed. Fetch only the content authorized for the
current application action, and decide separately what may enter model context
or durable storage.

## Bind the tool

```ts title="src/agents/assistant.ts"
'use agent';
import { type AgentProps, useModel, useTool } from '@flue/runtime';
import { emailIdFromInstanceId, retrieveReceivedEmail } from '../channels/resend.ts';

export function Assistant({ id }: AgentProps) {
  useModel('anthropic/claude-haiku-4-5');
  const emailId = emailIdFromInstanceId(id);
  useTool(retrieveReceivedEmail(emailId));
  return 'Review the inbound support email. Retrieve the complete email when its body or headers are needed.';
}
```

The model can retrieve only the email already bound by trusted application
code. Outbound send, forward, or reply tools should likewise bind credentials,
sender identity, recipients, and message policy outside model-selected
arguments.

The `resend-email:` id is an application convention for one inbound message.
The package does not expose a conversation helper because Resend's
`message_id` identifies one message rather than a stable thread root. Define
and persist any reply-grouping policy in application code.

## Delivery behavior

Resend delivery is at least once and ordering is not guaranteed. `delivery.id`
comes from the `svix-id` Resend documents for deduplication. Claim it in
application-owned durable storage before dispatch when duplicate admission is
unacceptable.

The channel is stateless. It does not register webhooks, manage receiving
domains or MX records, store credentials, deduplicate deliveries, restore
ordering, persist messages, retrieve bodies or attachments automatically, or
send replies.

## Cloudflare Workers

The official `resend@6.12.4` client and webhook verifier execute in Node and
workerd with Flue's required `nodejs_compat` configuration. Cloudflare projects
may initialize secrets through `process.env` or typed Worker bindings, then
should verify their complete Worker build.

Test ingress with original synthetic bodies and locally generated Svix-format
HMAC signatures over the exact bytes. Test the real client against a local
fake `baseUrl` and a Fetch stub that rejects unexpected destinations. Exercise
both paths in Node and workerd; tests should never contact Resend.

Receiving-domain configuration, webhook registration, API keys, signing-secret
rotation, deduplication, persistence, outbound mail, and reply behavior remain
application-owned.

See the [`@flue/resend` README](https://github.com/withastro/flue/tree/main/packages/resend#readme).
