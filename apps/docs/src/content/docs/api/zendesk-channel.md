---
title: Zendesk Channel API
description: Reference for verified Zendesk event-subscription ingress from @flue/zendesk.
---

Import from `@flue/zendesk`.

## Exports

```ts
export {
  createZendeskChannel,
  InvalidZendeskInputError,
  InvalidZendeskTicketKeyError,
  type ChannelRoute,
  type JsonObject,
  type JsonValue,
  type ZendeskChannel,
  type ZendeskChannelOptions,
  type ZendeskDelivery,
  type ZendeskEvent,
  type ZendeskHandlerResult,
  type ZendeskTicketRef,
  type ZendeskWebhookHandlerInput,
};
```

## `createZendeskChannel()`

```ts
function createZendeskChannel<E extends Env = Env>(
  options: ZendeskChannelOptions<E>,
): ZendeskChannel<E>;
```

Creates one stateless signed Zendesk event-subscription channel.

## `ZendeskChannelOptions`

```ts
interface ZendeskChannelOptions<E extends Env = Env> {
  signingSecret: string;
  accountId?: string;
  webhookId?: string;
  bodyLimit?: number;
  webhook(input: ZendeskWebhookHandlerInput<E>): ZendeskHandlerResult;
}
```

| Field           | Description                                                             |
| --------------- | ----------------------------------------------------------------------- |
| `signingSecret` | Zendesk webhook signing secret used for exact-body HMAC verification.   |
| `accountId`     | Optional expected payload and header account id.                        |
| `webhookId`     | Optional expected `X-Zendesk-Webhook-Id`.                               |
| `bodyLimit`     | Maximum request-body size in bytes. Defaults to 1 MiB.                  |
| `webhook`       | Receives every verified, structurally valid event-subscription payload. |

Configured secrets and ids must be non-empty. `bodyLimit` must be a positive
integer.

## Routes

```ts
interface ZendeskChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  ticketKey(ref: ZendeskTicketRef): string;
  parseTicketKey(id: string): ZendeskTicketRef;
}
```

`routes` contains one `POST /webhook` declaration. A file named
`channels/zendesk.ts` is served at `POST /channels/zendesk/webhook` relative to
the `flue()` mount.

## Handler input

```ts
interface ZendeskWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  payload: ZendeskEvent;
  delivery: ZendeskDelivery;
}
```

`c` is the authentic Hono context. `payload` is the verified provider-native
event-subscription envelope; `delivery` is the unsigned routing metadata read
from the request headers. The callback runs only after content type, body limit,
exact-body signature, UTF-8, JSON envelope, account consistency, and optional
configured identity checks pass.

## `ZendeskEvent`

The provider-native [common event envelope](https://developer.zendesk.com/api-reference/webhooks/event-types/webhook-event-types/),
preserving Zendesk's own snake_case field names, nesting, and discriminants.

```ts
interface ZendeskEvent<
  TDetail extends JsonObject = JsonObject,
  TEvent extends JsonObject = JsonObject,
> {
  account_id: string;
  id: string;
  type: string;
  subject: string;
  time: string;
  zendesk_event_version: string;
  event: TEvent;
  detail: TDetail;
  [key: string]: JsonValue;
}
```

| Field                   | Meaning                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `account_id`            | Zendesk account id, normalized to a positive decimal string.       |
| `id`                    | Provider event id. Use it as a replay-resistant deduplication key. |
| `type`                  | Open provider event type, e.g. `zen:event-type:ticket.created`.    |
| `subject`               | Provider resource subject, e.g. `zen:ticket:<id>`.                 |
| `time`                  | Provider event occurrence timestamp.                               |
| `zendesk_event_version` | Open provider schema version, e.g. `2022-06-20`.                   |
| `event`                 | Provider-native change object. Properties vary by event type.      |
| `detail`                | Provider-native resource object. Properties vary by event domain.  |

`type` and `zendesk_event_version` remain open strings, and the index signature
forwards any authenticated future or unmodeled fields. Verified future events
reach the handler. Narrow `detail` and `event` through the `TDetail`/`TEvent`
generics for the families you consume, and validate the fields you use.

JSON is parsed with `lossless-json`: safe numeric literals remain numbers,
while unsafe integer literals retain their exact decimal strings. The required
integer `account_id` is normalized to a positive decimal string and checked
against the provider account header.

## `ZendeskDelivery`

Unsigned provider delivery metadata from the request headers. Zendesk's HMAC
covers only the signature timestamp and request body, not these headers, so they
are routing and attempt-correlation context, never an authorization capability.

```ts
interface ZendeskDelivery {
  webhookId: string;
  invocationId: string;
  signatureTimestamp: string;
}
```

| Field                | Provider source                         | Meaning                                         |
| -------------------- | --------------------------------------- | ----------------------------------------------- |
| `webhookId`          | `X-Zendesk-Webhook-Id`                  | Webhook configuration identity.                 |
| `invocationId`       | `X-Zendesk-Webhook-Invocation-Id`       | Unsigned provider attempt-correlation identity. |
| `signatureTimestamp` | `X-Zendesk-Webhook-Signature-Timestamp` | Exact timestamp included in the HMAC input.     |

Prefer the signed `payload.id` for deduplication; `invocationId` only correlates
provider retry attempts.

## Verification

`POST /webhook` requires `application/json` and non-empty:

- `X-Zendesk-Account-Id`;
- `X-Zendesk-Webhook-Id`;
- `X-Zendesk-Webhook-Invocation-Id`;
- `X-Zendesk-Webhook-Signature`;
- `X-Zendesk-Webhook-Signature-Timestamp`.

The signature must be base64 HMAC-SHA256 over the exact signature timestamp
concatenated directly with the exact request bytes. Verification occurs before
decoding or parsing.

The HMAC covers the timestamp and body, not the identity headers. The package
requires the headers, checks body and header account identity for consistency,
and applies configured account and webhook restrictions. Header metadata is
not an authorization capability.

Zendesk documents no signature timestamp age or clock-skew rule. The package
does not reject an otherwise valid signature based on age.

Unsupported media types receive `415`; malformed input, identity metadata, or
signature-timestamp metadata receives `400`; oversized bodies receive `413`;
missing, malformed, or changed signatures receive `401`; configured identity
mismatches receive `403`.

## Handler result

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type ZendeskHandlerResult =
  | undefined
  | JsonValue
  | Response
  | Promise<undefined | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. A normal Hono or Fetch `Response` passes through unchanged. A
thrown callback or unsupported return value produces an empty `409`, which
Zendesk retries specifically.

Zendesk allows 12 seconds for the complete request. The channel does not enforce
a deadline, because racing the callback against a timer cannot actually cancel
JavaScript work that has already started. Admit durable work promptly (for
example `dispatch(...)` then return) and rely on idempotency rather than
blocking on slow work before acknowledging.

## Ticket identity

```ts
interface ZendeskTicketRef {
  accountId: string;
  ticketId: string;
}
```

`ticketKey()` serializes canonical account-scoped identity.
`parseTicketKey()` accepts only keys produced by the canonical format. The
application must derive and validate `ticketId` from a ticket event it handles;
the package does not claim every Zendesk event refers to a ticket.

Ticket keys identify application state. They do not authorize an outbound API
request or select account credentials.

## Errors

- `InvalidZendeskInputError`, with structured `field`, is thrown for an invalid
  ticket reference.
- `InvalidZendeskTicketKeyError` is thrown for a malformed or non-canonical
  ticket key.

## Delivery and application boundary

Zendesk can duplicate or omit delivery. It retries `409` up to three times,
conditionally retries `429` and `503` with a short `Retry-After`, retries
timeouts up to five times, and can pause failing endpoints through its circuit
breaker. Persist the signed `payload.id` in application-owned storage when
duplicate admission is unacceptable. `delivery.invocationId` is unsigned metadata
for attempt correlation.

This package supports provider-defined JSON event subscriptions. Custom
trigger and automation payloads, Sunshine Conversations, and Zendesk AI Agent
webhooks have different or incomplete contracts and are not accepted by this
route.

Webhook creation, subscription selection, destination authentication, OAuth,
token lookup, deduplication, persistence, ticket policy, outbound clients, and
tools remain application concerns.

`@flue/zendesk` depends on Hono and `lossless-json`. It does not depend on a
Zendesk SDK or `@flue/runtime`.

See [Zendesk setup](/docs/ecosystem/channels/zendesk/) for project-owned Fetch
composition, ticket-bound tools, retry behavior, and Node/workerd testing.
