---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developer.zendesk.com"
}
---

# Add a Zendesk Channel to Flue

You are an AI coding agent adding verified Zendesk event-subscription ingress
and application-owned Ticketing API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and deployment target, and
select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Inspect existing agents, environment types, secret
conventions, Zendesk account configuration, and the event families the
application needs.

Install `@flue/zendesk` and `lossless-json@^4.3.0`. Do not install
`node-zendesk` for this blueprint: Zendesk lists it as community maintained rather
than officially supported, and a narrow native Fetch client is portable across
Node and Cloudflare Workers. Add a compatible `@types/node` development
dependency only when the project needs types for `process` or `Buffer`.

Flue owns exact-body signature verification, required delivery metadata,
account consistency checks, body limits, and passing through the
provider-native common event envelope. The project owns webhook creation and
subscription selection, API tokens and OAuth, tenant credential lookup,
deduplication, persistence, ticket policy, and every outbound tool.

## Create the client

Create a small project-owned client such as
`<source-dir>/zendesk-client.ts`. Bind a bare Zendesk subdomain and API
credentials from trusted configuration:

```ts
import { isLosslessNumber, isSafeNumber, parse } from 'lossless-json';

export interface ZendeskClientOptions {
  subdomain: string;
  email: string;
  apiToken: string;
  fetcher?: typeof globalThis.fetch;
}

export interface ZendeskTicket {
  id: string | number;
  subject: string | null;
  status: string;
  requester_id: string | number;
  assignee_id: string | number | null;
  organization_id: string | number | null;
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export function createZendeskClient({
  subdomain,
  email,
  apiToken,
  fetcher = globalThis.fetch,
}: ZendeskClientOptions) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(subdomain)) {
    throw new TypeError('Zendesk subdomain must be a bare DNS label.');
  }
  if (!email || !apiToken) {
    throw new TypeError('Zendesk email and API token must be non-empty.');
  }
  const authorization = `Basic ${Buffer.from(
    `${email}/token:${apiToken}`,
  ).toString('base64')}`;

  return {
    async getTicket(ticketId: string): Promise<ZendeskTicket> {
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
      const payload = normalizeJsonValue(parse(await response.text()));
      if (!isRecord(payload) || !isTicket(payload.ticket)) {
        throw new TypeError('Zendesk returned an invalid ticket response.');
      }
      return payload.ticket;
    },
  };
}

function isTicket(value: unknown): value is ZendeskTicket {
  if (!isRecord(value)) return false;
  if (!isZendeskId(value.id)) return false;
  if (!(typeof value.subject === 'string' || value.subject === null)) {
    return false;
  }
  if (typeof value.status !== 'string') return false;
  if (!isZendeskId(value.requester_id)) return false;
  if (!(value.assignee_id === null || isZendeskId(value.assignee_id))) {
    return false;
  }
  return value.organization_id === null || isZendeskId(value.organization_id);
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

Use the account's original `*.zendesk.com` subdomain. Do not accept an
arbitrary API base URL or a host-mapped Help Center domain, because that could
send credentials to an unintended destination. OAuth bearer tokens are also
supported by Zendesk, but token acquisition and refresh remain
application-owned. Parse responses losslessly because Zendesk identifiers can
exceed JavaScript's safe integer range.

## Create the channel

Create `<source-dir>/channels/zendesk.ts`. Adapt the imported agent, selected
event types, and payload validation to the application:

```ts
// flue-blueprint: channel/zendesk@1
import {
  createZendeskChannel,
  type JsonValue,
  type ZendeskTicketRef,
} from '@flue/zendesk';
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
  webhookId: optionalEnv('ZENDESK_WEBHOOK_ID'),

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

function ticketIdFromEvent(
  subject: string,
  detail: Record<string, JsonValue>,
): string | undefined {
  const subjectMatch = /^zen:ticket:([1-9]\d*)$/.exec(subject);
  if (!subjectMatch?.[1]) return undefined;
  const detailId = detail.id;
  if (
    !(
      (typeof detailId === 'string' && /^[1-9]\d*$/.test(detailId)) ||
      (typeof detailId === 'number' &&
        Number.isSafeInteger(detailId) &&
        detailId > 0)
    )
  ) {
    return undefined;
  }
  return String(detailId) === subjectMatch[1] ? subjectMatch[1] : undefined;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function optionalEnv(name: string): string | undefined {
  return process.env[name] || undefined;
}
```

The callback receives the provider-native common event envelope as `payload`
with Zendesk's own field names (`account_id`, `id`, `type`, `subject`, `time`,
`zendesk_event_version`, `event`, `detail`), plus unsigned `delivery` metadata
from the request headers (`webhookId`, `invocationId`, `signatureTimestamp`).
The package keeps `type` and `zendesk_event_version` open. Validate fields used
by each selected event family. The example requires matching ticket identity in
both `subject` and `detail.id`; customize that policy only from Zendesk's
documented payload for the event types you subscribe to.

Zendesk's current documentation is inconsistent about ticket delivery setup:
the event catalog and Support UI documentation list ticket subscriptions,
while the developer webhook guide still recommends triggers or automations for
ticket activity. Use the grouped ticket example only when the target account
exposes those event subscriptions. Otherwise, research and implement the
account's customizable trigger payload as a separate application-specific
channel instead of passing it through this fixed event-envelope contract.

Zendesk's HMAC covers the signature timestamp concatenated directly with the
exact request body. It does not cover the account, webhook, or invocation
headers. The package requires those headers and checks payload `account_id`
against the account header, but they remain provider routing metadata rather
than independent authorization capabilities.

## Wire the agent

Bind the account and ticket selected by verified application code:

```ts
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

The tool accepts no account, ticket id, subdomain, token, or API host from the
model. The canonical key is an identifier, not an authorization capability;
apply the project's normal policy to direct agent routes.

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Configure the endpoint

Create a Zendesk webhook event subscription with:

```txt
https://example.com/channels/zendesk/webhook
```

If `flue()` has an outer mount prefix, include it. Configure JSON delivery and
use the webhook's signing secret as `ZENDESK_WEBHOOK_SIGNING_SECRET`.

Zendesk sends:

```txt
X-Zendesk-Account-Id
X-Zendesk-Webhook-Id
X-Zendesk-Webhook-Invocation-Id
X-Zendesk-Webhook-Signature
X-Zendesk-Webhook-Signature-Timestamp
```

The signature is base64 HMAC-SHA256 over:

```txt
<signature timestamp><exact request body>
```

There is no delimiter. The channel verifies the bytes before UTF-8 decoding
or JSON parsing. Zendesk does not document a timestamp acceptance window, so
the channel exposes the timestamp but does not invent a clock-skew or freshness
rule. Persist the signed provider event id when duplicate admission is
unacceptable. Use the unsigned invocation header only to correlate provider
delivery attempts.

`ZENDESK_WEBHOOK_SIGNING_SECRET` verifies ingress.
`ZENDESK_API_TOKEN` authenticates the project-owned Ticketing API client. They
are separate credentials. `ZENDESK_WEBHOOK_ID` is an optional consistency
restriction for deployments dedicated to one webhook.

## Response and delivery behavior

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body. A normal Hono or Fetch `Response` passes through unchanged. A
thrown callback or unsupported return value produces `409`, which Zendesk
retries up to three times.

Zendesk allows 12 seconds for the complete request. The channel does not
enforce a deadline, because racing the application callback against a timer
cannot actually cancel JavaScript work that has already started — the timed-out
work keeps running while a misleading failure is returned. Instead, admit
durable work promptly (for example `dispatch(...)` then return) and rely on
idempotency rather than blocking on slow operations before acknowledging.

Zendesk retries `409` responses up to three times. It retries `429` and `503`
when `Retry-After` is less than 60 seconds, and retries timeouts up to five
times. Delivery is best effort and may be duplicated or omitted. Zendesk can
also pause a failing endpoint through its circuit breaker.

Use the default exact `200` for ordinary acknowledgment. Use custom response
statuses only when their retry behavior is intentional.

## Scope boundaries

This blueprint targets provider-defined JSON event subscriptions. Do not broaden
the same callback to customizable trigger or automation payloads: those can
use different HTTP methods, media types, and developer-authored schemas.

Sunshine Conversations uses a separate API-key protocol, explicit event
batches, and different retry behavior. Zendesk AI Agent webhooks currently
lack a documented trustworthy inbound authentication contract. Treat either
as separate future channel research rather than silently accepting them here.

The package does not create a webhook, choose subscriptions, configure
triggers, perform OAuth, store tokens, deduplicate events, persist tickets, or
define support workflow policy.

## Test without Zendesk

Run the project's strict typecheck, Node build, Cloudflare build, and actual
workerd tests. Flue projects already enable `nodejs_compat`.

Create an original synthetic common event envelope and local signing secret.
Serialize the body once, prepend the exact signature timestamp, HMAC-SHA256
those bytes, and base64-encode the digest. Cover:

- valid exact bytes and rejection after changing one byte;
- missing, malformed, and incorrect signature inputs;
- required account, webhook, invocation, and timestamp headers;
- payload/header account mismatch and configured account or webhook mismatch;
- selected ticket events plus a future event type and schema version;
- an unsafe numeric `account_id` preserved without rounding;
- malformed UTF-8 and JSON, media type, and declared and streamed body limits;
- no-value, JSON, and normal `Response` results;
- a thrown callback failing closed with `409` and canonical ticket-key round trip.

Test the exported client in Node and workerd with injected fail-closed Fetch.
Assert the exact `*.zendesk.com/api/v2/tickets/{id}.json` URL, `GET` method,
Basic authorization, and response parsing. Reject every unexpected
destination and confirm `process` and `Buffer` are provided by
`nodejs_compat`.

Never create or modify a live webhook, subscribe to live events, request a real
token, or contact Zendesk during implementation or testing.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
