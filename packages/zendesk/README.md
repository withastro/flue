# `@flue/zendesk`

Verified Zendesk event-subscription webhook ingress for Flue.

The package exposes one fixed `POST /webhook` route and verifies Zendesk's
base64 HMAC-SHA256 over the signature timestamp concatenated directly with the
exact request bytes before parsing the payload or calling application code.

```ts
import { createZendeskChannel } from '@flue/zendesk';

export const channel = createZendeskChannel({
  signingSecret: process.env.ZENDESK_WEBHOOK_SIGNING_SECRET!,
  accountId: process.env.ZENDESK_ACCOUNT_ID!,

  // Path: /channels/zendesk/webhook
  webhook({ payload }) {
    if (payload.type.startsWith('zen:event-type:ticket.')) {
      // Validate the ticket event fields you consume, then dispatch work.
    }
  },
});
```

Place this export in `channels/zendesk.ts`. Flue discovers it and serves
`POST /channels/zendesk/webhook` relative to the `flue()` mount.

The callback receives `{ c, payload, delivery }`. `payload` is the
provider-native common event envelope with Zendesk's own snake_case field names
(`account_id`, `id`, `type`, `subject`, `time`, `zendesk_event_version`,
`event`, `detail`); an index signature forwards any authenticated future fields.
`delivery` is a sibling object of unsigned routing metadata read from the request
headers (`webhookId`, `invocationId`, `signatureTimestamp`). Zendesk's event
catalog remains open, so provider-specific `detail` and `event` objects are
JSON-typed. Numeric literals outside JavaScript's safe range are represented as
strings, and the required integer `account_id` is normalized to a positive
decimal string. The HMAC authenticates only the signature timestamp concatenated
with the exact body. The `delivery` headers are provider metadata; the package
matches the signed body `account_id` against the account header and can apply
configured account and webhook restrictions, but does not claim the headers are
independently signed.

Returning no value or a JSON-compatible value acknowledges the delivery with
`200`. A returned Hono or Fetch `Response` passes through unchanged. A thrown
callback or unsupported return value fails closed with retryable `409`. Zendesk
allows 12 seconds for the complete request; the channel does not enforce a
deadline, because a timer cannot cancel JavaScript work that has already
started. Admit durable work promptly (for example `dispatch(...)` then return)
and rely on idempotency rather than blocking before acknowledging.

Zendesk documents no signature freshness window, may redeliver or omit events,
and does not guarantee ordering. Persist the signed `payload.id` for
application-owned deduplication. Use unsigned `delivery.invocationId` only to
correlate provider delivery attempts.

`instanceId({ accountId, ticketId })` and `parseInstanceId(id)` provide
canonical account-scoped ticket identifiers. They do not authorize access and
the package does not infer a ticket from event families the application has
not validated.

Webhook creation, triggers and automations, destination authentication, OAuth,
token storage, deduplication, ticket policy, Sunshine Conversations, AI Agent
webhooks, and outbound Zendesk API behavior remain application-owned or outside
this package.
