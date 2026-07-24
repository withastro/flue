# Zendesk channel example

This project receives verified Zendesk ticket events at
`POST /channels/zendesk/webhook`, groups useful ticket events, and dispatches
them through canonical account-scoped ticket identity.

It demonstrates:

- exporting a first-party `channel`;
- exporting a project-owned native Fetch `client`;
- handling ticket creation and comments together;
- dispatching through `channel.instanceId({ accountId, ticketId })`;
- exposing a narrow tool that retrieves only the already-bound ticket;
- testing the same client in Node and workerd with `nodejs_compat`.

Required environment variables:

```sh
ZENDESK_WEBHOOK_SIGNING_SECRET=...
ZENDESK_ACCOUNT_ID=...
ZENDESK_SUBDOMAIN=example
ZENDESK_EMAIL=agent@example.com
ZENDESK_API_TOKEN=...
```

This optional value restricts delivery to one configured webhook:

```sh
ZENDESK_WEBHOOK_ID=...
```

Configure Zendesk to send JSON event-subscription requests to:

```txt
POST /channels/zendesk/webhook
```

The channel verifies Zendesk's base64 HMAC-SHA256 signature over the signature
timestamp concatenated directly with the exact request body before invoking
the handler. The signed body account id is matched to Zendesk's required
account header. When configured, the webhook header restriction is an
additional consistency check; Zendesk's account, webhook, and invocation
headers are not included in the HMAC.

The exported client binds the trusted Zendesk subdomain, email, and API token
in application code. It accepts only a bare DNS label for the subdomain, always
targets that account's `https://<subdomain>.zendesk.com/api/v2` origin, and uses
Zendesk's API-token Basic authentication. `getTicket()` accepts only a positive
decimal ticket id. The retrieval tool has no model-controlled parameters, so
the model cannot select another account, host, credential, or ticket.
Ticket responses are parsed with `lossless-json`; unsafe numeric ticket,
requester, assignee, and organization ids remain exact decimal strings.

The handler intentionally dispatches only selected ticket events and requires
the ticket id in `subject` and `detail.id` to agree before using it as
application identity. Other verified event families remain observable to
applications that choose to add their own cases. Zendesk may retry, duplicate,
omit, or deliver events out of order. Applications that require exactly-once
effects must persist and claim the signed provider event id before dispatch.
The invocation id is unsigned provider metadata and should be used only to
correlate delivery attempts.

Zendesk's current documentation is inconsistent about ticket delivery setup:
its event catalog and Support UI documentation list ticket subscriptions,
while the developer webhook guide still recommends triggers or automations for
ticket activity. Use this example when the account exposes ticket event
subscriptions. Custom trigger payloads are developer-authored and do not use
this package's fixed common event envelope.

Webhook registration, triggers and automations, OAuth, token storage,
deduplication, replay persistence, Sunshine Conversations, and Zendesk AI
Agent webhooks remain application-owned or out of scope.

The Node and workerd tests execute `client.getTicket()` against injected Fetch
implementations that throw on every unexpected destination. They never contact
Zendesk:

```sh
pnpm run check:types
pnpm run test
pnpm run build
pnpm run build:cloudflare
```
