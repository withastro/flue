# Resend Channel

Use this for `@flue/resend`, verified webhooks, inbound email retrieval, and message-scoped agent instances.

## Setup

- Run `flue add channel resend`.
- Use `@flue/resend` for verified ingress.
- Use official `resend` SDK for outbound API and email retrieval.
- Required environment:
  - `RESEND_WEBHOOK_SECRET`
  - `RESEND_API_KEY`
- Configure webhook URL: `https://example.com/channels/resend/webhook`.
- Webhook secret and outbound API key are separate credentials.

The SDK declarations may require `@types/node` and `@types/react` as development dependencies; these add no Node or React runtime code to Worker bundles.

## Webhook Behavior

- `createResendChannel({ client, webhookSecret, webhook })` verifies exact request body and Svix headers.
- Returning nothing produces empty `200`.
- JSON-compatible values become response bodies.
- Hono/Fetch responses pass through.
- Resend retries every status other than `200`; return non-`200` only when redelivery is intentional.
- Events preserve official provider-native fields, including newer event types.
- `switch (event.type)` narrows modeled variants; keep a default branch for SDK-newer events.

## Inbound Email

- `email.received` includes routing metadata and attachment descriptors.
- Retrieve full body, headers, and current attachment metadata later through `client.emails.receiving.get(emailId)`.
- Use attachment APIs for signed download URLs only when attachment content is needed.
- Decide separately what email content may enter model context or durable storage.

## Instance IDs And Tools

- Use an application convention such as `resend-email:${encodeURIComponent(emailId)}` for one inbound message.
- Bind `retrieveReceivedEmail(emailId)` in trusted code so the model can retrieve only the email already bound to the agent.
- Outbound send, forward, or reply tools should bind credentials, sender identity, recipients, and message policy outside model-selected arguments.
- The package does not expose a conversation helper because Resend `message_id` identifies one message rather than a stable thread root.

## Delivery

- Resend delivery is at least once and ordering is not guaranteed.
- `delivery.id` comes from `svix-id` and is useful for deduplication.
- Claim delivery IDs in application storage before dispatch when duplicate admission is unacceptable.
- The channel does not register webhooks, manage receiving domains, store credentials, deduplicate, restore ordering, persist messages, retrieve bodies automatically, or send replies.

