---
title: Zendesk
description: Receive verified Zendesk events and use a ticket-bound Fetch client from application-owned tools.
package:
  name: '@flue/zendesk'
  href: https://www.npmjs.com/package/@flue/zendesk
---

## Quickstart

Add verified event-subscription ingress and application-owned Ticketing API behavior to an existing Flue project with the [Zendesk](https://developer.zendesk.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel zendesk
```

## Overview

The blueprint installs `@flue/zendesk` and `lossless-json`. It creates a narrow
Fetch client at `<source-root>/zendesk-client.ts` and
`<source-root>/channels/zendesk.ts` with named `channel` and project-owned
`client` exports, ticket identity handling, and a ticket-bound retrieval tool.
It wires that tool into an agent and adds Node types only when the target needs
them; no community Zendesk SDK is installed.

```ts title="src/channels/zendesk.ts (abridged)"
import { createZendeskChannel } from '@flue/zendesk';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createZendeskClient } from '../zendesk-client.ts';

export const client = createZendeskClient({
  subdomain: process.env.ZENDESK_SUBDOMAIN!,
  email: process.env.ZENDESK_EMAIL!,
  apiToken: process.env.ZENDESK_API_TOKEN!,
});

export const channel = createZendeskChannel({
  signingSecret: process.env.ZENDESK_WEBHOOK_SIGNING_SECRET!,
  accountId: process.env.ZENDESK_ACCOUNT_ID!,
  async webhook({ payload }) {
    if (payload.type !== 'zen:event-type:ticket.created') return;
    const ticketId = ticketIdFromEvent(payload.subject, payload.detail);
    if (!ticketId) return;

    await dispatch(assistant, {
      id: channel.ticketKey({ accountId: payload.account_id, ticketId }),
      input: { type: `zendesk.${payload.type}`, eventId: payload.id, ticketId },
    });
  },
});
```

The abridged example omits the `ticketIdFromEvent()` helper; the complete helper
appears in the channel module below.

A matching ticket event is admitted to the agent bound to that account and
ticket, while other verified events receive an empty successful response. The
full generated module validates matching ticket identity in `subject` and
`detail.id`, handles comment events, and lets the bound agent retrieve the
current ticket through the project-owned client. That client preserves large
Zendesk identifiers and runs in Node or Cloudflare Workers.

## Configure

| Variable                         | Purpose                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `ZENDESK_WEBHOOK_SIGNING_SECRET` | **Required** — Verifies inbound event bodies.                          |
| `ZENDESK_ACCOUNT_ID`             | **Required** — Restricts events and resource identity to one account.  |
| `ZENDESK_WEBHOOK_ID`             | **Optional** — Restricts deliveries to one configured webhook.         |
| `ZENDESK_SUBDOMAIN`              | **Required** — Selects the account's Ticketing API origin.             |
| `ZENDESK_EMAIL`                  | **Required** — Identifies the API-token user for Basic authentication. |
| `ZENDESK_API_TOKEN`              | **Required** — Authenticates outbound Ticketing API requests.          |

It installs `@flue/zendesk` and creates a channel module with named `channel`
and project-owned `client` exports. Zendesk has no officially supported Node
server SDK, so the blueprint uses a narrow native Fetch client instead of adding a
community wrapper.

Create a JSON event-subscription webhook with:

```txt
https://example.com/channels/zendesk/webhook
```

The webhook signing secret and outbound API token are separate credentials.

## Channel module

```ts title="src/channels/zendesk.ts"
import { createZendeskChannel, type JsonValue, type ZendeskTicketRef } from '@flue/zendesk';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createZendeskClient } from '../zendesk-client.ts';

const accountId = requiredEnv('ZENDESK_ACCOUNT_ID');

export const client = createZendeskClient({
  subdomain: requiredEnv('ZENDESK_SUBDOMAIN'),
  email: requiredEnv('ZENDESK_EMAIL'),
  apiToken: requiredEnv('ZENDESK_API_TOKEN'),
});

export const channel = createZendeskChannel({
  signingSecret: requiredEnv('ZENDESK_WEBHOOK_SIGNING_SECRET'),
  accountId,
  webhookId: process.env.ZENDESK_WEBHOOK_ID || undefined,

  // Path: /channels/zendesk/webhook
  async webhook({ c, payload, delivery }) {
    switch (payload.type) {
      case 'zen:event-type:ticket.created':
      case 'zen:event-type:ticket.comment_added': {
        const ticketId = ticketIdFromEvent(payload.subject, payload.detail);
        if (!ticketId) {
          return c.json({ error: 'Expected a Zendesk ticket event.' }, 400);
        }

        const ticket: ZendeskTicketRef = {
          accountId: payload.account_id,
          ticketId,
        };
        await dispatch(assistant, {
          id: channel.ticketKey(ticket),
          input: {
            type: `zendesk.${payload.type}`,
            eventId: payload.id,
            invocationId: delivery.invocationId,
            occurredAt: payload.time,
            ticketId,
            change: payload.event,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveTicket(ref: ZendeskTicketRef) {
  if (ref.accountId !== accountId) {
    throw new TypeError('Expected the configured Zendesk account.');
  }
  return defineTool({
    name: 'retrieve_zendesk_ticket',
    description: 'Retrieve the Zendesk ticket already bound to this agent.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      return JSON.stringify(await client.getTicket(ref.ticketId));
    },
  });
}

function ticketIdFromEvent(subject: string, detail: Record<string, JsonValue>): string | undefined {
  const match = /^zen:ticket:([1-9]\d*)$/.exec(subject);
  if (!match?.[1]) return undefined;
  const id = detail.id;
  if (
    !(
      (typeof id === 'string' && /^[1-9]\d*$/.test(id)) ||
      (typeof id === 'number' && Number.isSafeInteger(id) && id > 0)
    )
  ) {
    return undefined;
  }
  return String(id) === match[1] ? match[1] : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
```

The grouped branch handles selected ticket events while leaving the provider
catalog open. Validate the fields consumed for every subscribed type. The
example requires the ticket id in `subject` and `detail.id` to agree before
using it as application identity.

## Project-owned client

Use the original account subdomain and bind credentials in trusted code:

```ts title="src/zendesk-client.ts"
import { isLosslessNumber, isSafeNumber, parse } from 'lossless-json';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export function createZendeskClient({
  subdomain,
  email,
  apiToken,
  fetcher = globalThis.fetch,
}: {
  subdomain: string;
  email: string;
  apiToken: string;
  fetcher?: typeof globalThis.fetch;
}) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(subdomain)) {
    throw new TypeError('Zendesk subdomain must be a bare DNS label.');
  }
  const authorization = `Basic ${Buffer.from(`${email}/token:${apiToken}`).toString('base64')}`;

  return {
    async getTicket(ticketId: string) {
      if (!/^[1-9]\d*$/.test(ticketId)) {
        throw new TypeError('Zendesk ticket id must be a positive integer.');
      }
      const response = await fetcher(
        `https://${subdomain}.zendesk.com/api/v2/tickets/${ticketId}.json`,
        {
          headers: {
            accept: 'application/json',
            authorization,
          },
        },
      );
      if (!response.ok) {
        throw new Error(`Zendesk API request failed with ${response.status}.`);
      }
      const body = normalizeJsonValue(parse(await response.text()));
      if (!isRecord(body) || !isRecord(body.ticket) || !isZendeskId(body.ticket.id)) {
        throw new TypeError('Zendesk returned an invalid ticket response.');
      }
      return body.ticket;
    },
  };
}

function isZendeskId(value: unknown): value is string | number {
  if (typeof value === 'string') return /^[1-9]\d*$/.test(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function normalizeJsonValue(value: unknown): JsonValue | undefined {
  if (
    value === null ||
    typeof value === 'boolean' ||
    typeof value === 'string' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (isLosslessNumber(value)) {
    return isSafeNumber(value.value) ? Number(value.value) : value.value;
  }
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const item of value) {
      const normalized = normalizeJsonValue(item);
      if (normalized === undefined) return undefined;
      result.push(normalized);
    }
    return result;
  }
  if (!isRecord(value)) return undefined;
  const result: { [key: string]: JsonValue } = {};
  for (const [key, item] of Object.entries(value)) {
    const normalized = normalizeJsonValue(item);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    !isLosslessNumber(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}
```

Zendesk documents API-token Basic authentication as
`{email}/token:{api_token}`. OAuth bearer tokens are also available, but
authorization setup, token refresh, and installation storage remain
application-owned.

Do not accept an arbitrary base URL from a model or webhook field. Host-mapped
Help Center domains do not replace the account's original
`<subdomain>.zendesk.com` API origin.

Install `lossless-json@4.3.0` for this client. Zendesk identifiers can exceed
JavaScript's safe integer range, so unsafe numeric ids remain decimal strings
instead of being rounded.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { defineAgent } from '@flue/runtime';
import { channel, retrieveTicket } from '../channels/zendesk.ts';

export default defineAgent(({ id }) => {
  const ticket = channel.parseTicketKey(id);
  return {
    model: 'anthropic/claude-haiku-4-5',
    tools: [retrieveTicket(ticket)],
  };
});
```

The tool accepts no account, ticket id, API host, or credential from the model.
`ticketKey()` includes account and ticket identity because Zendesk resource ids
are account-scoped. The key remains an identifier, not an authorization
capability.

## Verification

Zendesk sends:

```txt
X-Zendesk-Account-Id
X-Zendesk-Webhook-Id
X-Zendesk-Webhook-Invocation-Id
X-Zendesk-Webhook-Signature
X-Zendesk-Webhook-Signature-Timestamp
```

The signature is base64 HMAC-SHA256 over the signature timestamp concatenated
directly with the exact request body. There is no delimiter.
`@flue/zendesk` preserves and verifies those bytes before UTF-8 decoding or
JSON parsing.

The HMAC covers the timestamp and body, not the account, webhook, or invocation
headers. The package requires those headers, checks payload `account_id`
against the account header, and can restrict configured account and webhook
ids. Treat header metadata as provider routing context rather than independent
authorization.

Zendesk does not document a timestamp acceptance window or clock-skew rule.
The channel exposes `delivery.signatureTimestamp` but does not invent freshness
semantics.

## Event shape

The callback receives `{ c, payload, delivery }`, keeping the Flue-verified
provider-native payload separate from the unsigned header metadata.

`payload` is Zendesk's own [common event envelope](https://developer.zendesk.com/api-reference/webhooks/event-types/webhook-event-types/),
with the provider's snake_case field names:

- `account_id`, normalized to a positive decimal string;
- `id`, the provider event id;
- `type` and `zendesk_event_version`, both open strings;
- `subject` such as `zen:ticket:<id>`, and `time`;
- provider-native `detail` and `event` JSON objects.

An index signature forwards any authenticated future or unmodeled fields, so
verified future event families remain observable. JSON is parsed losslessly:
unsafe integer literals retain their exact decimal spelling as strings, and the
top-level integer `account_id` is normalized to a decimal string.

`delivery` is the unsigned routing metadata read from the request headers:
`webhookId`, `invocationId`, and `signatureTimestamp`. Zendesk's HMAC does not
cover these headers, so treat them as provider routing context, not
authorization.

Zendesk's current documentation is inconsistent about ticket delivery setup:
the event catalog and Support UI documentation list ticket subscriptions,
while the developer webhook guide still recommends triggers or automations for
ticket activity. Use the grouped ticket example only when the account exposes
those event subscriptions. Custom trigger payloads are developer-authored and
are not accepted as if they were the fixed common event envelope.

This initial channel targets provider-defined JSON event subscriptions.
Custom trigger and automation webhooks can use developer-authored payloads,
other media types, and other methods, so they are not silently treated as the
same protocol. Sunshine Conversations and Zendesk AI Agent webhooks also have
different or incomplete authentication and delivery contracts and remain
separate research.

## Responses and delivery

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. A normal Hono or Fetch `Response` passes through unchanged. A
thrown callback or unsupported return value fails closed with retryable `409`.

Zendesk allows 12 seconds for the complete request. The channel does not enforce
a deadline, because racing the callback against a timer cannot actually cancel
JavaScript work that has already started — the timed-out work keeps running while
a misleading failure is returned. Instead, admit durable work promptly (for
example `dispatch(...)` then return) and rely on idempotency rather than
blocking on slow operations before acknowledging.

Zendesk retries `409` up to three times, conditionally retries `429` and `503`
with a short `Retry-After`, and retries timeouts up to five times. Delivery is
best effort and may be duplicated or omitted. Persist the signed `payload.id` in
application-owned storage when duplicate admission is unacceptable. The unsigned
`delivery.invocationId` is useful for correlating provider attempts but is not a
replay-resistant deduplication key. Use an exact `200` for ordinary
acknowledgment.

## Cloudflare Workers

Ingress uses Web Crypto and standards-based Fetch APIs. The project-owned
client uses native Fetch plus `Buffer` for documented Basic authentication.
Both paths execute in workerd with Flue's required `nodejs_compat`
configuration.

Test the real exported client with injected fail-closed Fetch in Node and
workerd. Assert the exact Zendesk host, ticket path, method, and authorization
header, and reject every unexpected destination. Create original synthetic
events and local HMACs for ingress tests. Do not create a webhook, subscribe to
live events, obtain a real token, or contact Zendesk.

See the [`@flue/zendesk` README](https://github.com/withastro/flue/tree/main/packages/zendesk#readme).
