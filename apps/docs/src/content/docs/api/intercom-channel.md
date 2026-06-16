---
title: Intercom Channel API
description: Reference for verified Intercom webhook ingress from @flue/intercom.
---

Import from `@flue/intercom`.

## Exports

```ts
export {
  createIntercomChannel,
  InvalidIntercomConversationKeyError,
  InvalidIntercomInputError,
  type ChannelRoute,
  type IntercomChannel,
  type IntercomChannelOptions,
  type IntercomConversationRef,
  type IntercomHandlerResult,
  type IntercomNotification,
  type IntercomNotificationData,
  type IntercomWebhookHandlerInput,
  type JsonObject,
  type JsonValue,
};
```

## `createIntercomChannel()`

```ts
function createIntercomChannel<E extends Env = Env>(
  options: IntercomChannelOptions<E>,
): IntercomChannel<E>;
```

Creates one stateless Intercom channel with endpoint-validation and signed
notification routes.

## `IntercomChannelOptions`

```ts
interface IntercomChannelOptions<E extends Env = Env> {
  clientSecret: string;
  bodyLimit?: number;
  webhook(input: IntercomWebhookHandlerInput<E>): IntercomHandlerResult;
}
```

| Field          | Description                                                             |
| -------------- | ----------------------------------------------------------------------- |
| `clientSecret` | Developer app client secret used for exact-body HMAC-SHA1 verification. |
| `bodyLimit`    | Maximum request-body size in bytes. Defaults to 1 MiB.                  |
| `webhook`      | Receives every verified, structurally valid topic, including `ping`.    |

The constructor throws `TypeError` for a missing options object, empty
`clientSecret`, a missing callback, or a non-positive body limit.

## Routes

```ts
interface IntercomChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: IntercomConversationRef): string;
  parseConversationKey(id: string): IntercomConversationRef;
}
```

`routes` always contains:

- `HEAD /webhook`, which returns an empty `200` for Intercom endpoint
  validation without invoking application code;
- `POST /webhook`, which verifies and delivers one notification.

A file named `channels/intercom.ts` is served at
`HEAD /channels/intercom/webhook` and `POST /channels/intercom/webhook`
relative to the `flue()` mount.

## Handler input

```ts
interface IntercomWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  notification: IntercomNotification;
}
```

`c` is the authentic Hono context. `webhook` runs only after content type, body
limit, signature, UTF-8, and JSON envelope checks pass.

## `IntercomNotification`

The callback receives Intercom's own notification object unchanged, with the
provider's native field names and nesting.

```ts
interface IntercomNotificationData {
  item: JsonValue;
  [key: string]: JsonValue;
}

interface IntercomNotification {
  type: 'notification_event';
  topic: string;
  app_id: string;
  id: string | null;
  created_at: number;
  delivery_attempts: number;
  first_sent_at: number;
  data: IntercomNotificationData;
  self?: string | null;
  [key: string]: JsonValue | undefined;
}
```

| Field               | Meaning                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `type`              | Always `notification_event` after envelope validation.                 |
| `topic`             | Open provider topic string, e.g. `conversation.user.replied`.          |
| `app_id`            | Intercom workspace identity in the notification envelope.              |
| `id`                | Notification identity for application-owned dedupe; pings may be null. |
| `created_at`        | Provider creation timestamp in Unix seconds.                           |
| `delivery_attempts` | Positive provider attempt count.                                       |
| `first_sent_at`     | First-send timestamp in Unix seconds.                                  |
| `data.item`         | Provider-native, API-versioned JSON payload for the affected resource. |
| `self`              | Optional provider notification URL.                                    |

`topic` is deliberately not a closed union. Verified future topics remain
observable. `data.item` is JSON-typed because Intercom's catalog is broad and
versioned, deletion topics can contain minimal data, and some conversation,
ticket, and conversation-part topics use different wrappers. Applications
must validate the item fields consumed for each topic.

The notification is passed through unchanged: unmodeled top-level fields (for
example `delivery_status`, `delivered_at`, or `links` on newer topics) are
forwarded via the index signature. The package validates the common
notification envelope. It does not claim that every topic has a conversation
id, ticket id, actor, or resource shape.

## Verification

`POST /webhook` requires `application/json` and:

```txt
X-Hub-Signature: sha1=<40 hexadecimal characters>
```

The package verifies HMAC-SHA1 over the exact request bytes with
`clientSecret` before decoding or parsing. Web Crypto verification executes in
Node and workerd.

Unsupported media types receive `415`; malformed `Content-Length`, UTF-8,
JSON, or envelopes receive `400`; oversized bodies receive `413`; and missing,
malformed, or changed signatures receive `401`.

Intercom supplies no signed timestamp, nonce, or protocol replay window.
Verification does not deduplicate notifications or establish freshness.

## Handler result

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

type IntercomHandlerResult =
  | undefined
  | JsonValue
  | Response
  | Promise<undefined | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response with status `200`. A normal Hono or Fetch `Response` passes
through unchanged. A thrown callback or unsupported return value surfaces to
the framework error handler as an empty `500`.

Intercom acknowledges on any `2xx`. Use `200` for ordinary acknowledgment.
Custom statuses pass through, but should be used only with Intercom's retry
semantics in mind: `410` disables a subscription and `429` throttles it.

Intercom expects a `2xx` within about five seconds and otherwise retries the
notification once after one minute. The channel does not enforce this with a
timer, because a promise timeout cannot cancel running JavaScript. Admit
durable work quickly — dispatch and return — and rely on `id` for idempotency
rather than blocking the callback on slow operations.

## Conversation identity

```ts
interface IntercomConversationRef {
  workspaceId: string;
  conversationId: string;
}
```

Intercom resource ids are not globally unique, so canonical conversation
identity includes both values. `conversationKey()` serializes the reference as
a canonical `intercom:v1:workspace:...:conversation:...` identifier, escaping
provider values. `parseConversationKey()` accepts only canonical keys produced
by that format.

These keys identify application state; they do not authorize an outbound API
request or select installation credentials.

## Errors

- `InvalidIntercomInputError`, with structured `field`, is thrown for an
  invalid conversation reference.
- `InvalidIntercomConversationKeyError` is thrown for a malformed or
  non-canonical key.

## Delivery and application boundary

The channel exposes notification identity and attempt metadata but does not
persist deduplication state or restore ordering. Pings may not have a
notification id.

App installation, OAuth, permissions, workspace token lookup, webhook
subscription setup, deduplication, replay persistence, inbox policy, ticket
workflows, outbound clients, and tools remain application concerns.

`@flue/intercom` depends only on Hono and standards-based Web Crypto. It does
not depend on `intercom-client` or `@flue/runtime`.

See [Intercom setup](/docs/ecosystem/channels/intercom/) for official client
composition, API version and region selection, application-owned tools, and
Node/workerd testing guidance.
