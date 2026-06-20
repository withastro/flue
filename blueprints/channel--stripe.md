---
{
  "kind": "channel",
  "version": 1,
  "website": "https://stripe.com"
}
---

# Add a Stripe Channel to Flue

You are an AI coding agent adding verified Stripe webhook ingress and
application-owned Stripe API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, the
Stripe event destination's payload style, and which event types the application
needs.

Install `@flue/stripe` and Stripe's official `stripe@^22.2.1` SDK with the
project's package manager. In a TypeScript project, keep the compatible
`@types/node` peer available because Stripe's declarations reference those
types even when the runtime selects its Worker implementation. Add it as a
development dependency when the package manager does not install required
peers automatically. Do not add a generic Stripe tool collection.

Use snapshot events by default. Set `eventPayload: 'thin'` only when the Stripe
event destination is explicitly configured to send thin event notifications.

## Create the channel

Create `<source-dir>/channels/stripe.ts`. Adapt the imported agent, dispatched
input, and customer policy to the application, but preserve the project-owned
client and fixed route:

```ts
// flue-blueprint: channel/stripe@1
import Stripe from 'stripe';
import { createStripeChannel } from '@flue/stripe';
import { defineTool, dispatch } from '@flue/runtime';
import billing from '../agents/billing.ts';

export const client = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  httpClient: Stripe.createFetchHttpClient(),
});

export const channel = createStripeChannel({
  client,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,

  // Path: /channels/stripe/webhook
  async webhook({ event }) {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        const customerId =
          typeof session.customer === 'string'
            ? session.customer
            : session.customer?.id;
        if (!customerId) return;

        await dispatch(billing, {
          id: customerId,
          input: {
            type: `stripe.${event.type}`,
            eventId: event.id,
            checkoutSessionId: session.id,
            customerId,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveCustomer(customerId: string) {
  return defineTool({
    name: 'retrieve_stripe_customer',
    description: 'Retrieve the Stripe customer bound to this billing agent.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const customer = await client.customers.retrieve(customerId);
      return JSON.stringify(
        'deleted' in customer
          ? { id: customer.id, deleted: true }
          : { id: customer.id, name: customer.name, email: customer.email },
      );
    },
  });
}
```

The example assumes one Stripe account and uses its customer id as the agent
instance id. For Connect or organization destinations, derive a stable
application-specific id that also includes the verified `event.account` or
`event.context`, and bind the matching request context in trusted code.

If the application does not need customer retrieval, replace or omit the
example tool. Never let the model choose arbitrary Stripe accounts,
credentials, customer ids, API paths, or request options unless the
application has explicitly authorized that access.

## Wire the agent

Bind the trusted customer id inside the agent initializer:

```ts
import { defineAgent } from '@flue/runtime';
import { retrieveCustomer } from '../channels/stripe.ts';

export default defineAgent(({ id: customerId }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [retrieveCustomer(customerId)],
}));
```

The channel-agent import cycle is supported only because imported bindings are
read inside deferred callbacks and initializers. Do not read the agent binding
while constructing `channel`.

## Thin event notifications

For a destination configured with thin payloads, make the mode explicit:

```ts
export const channel = createStripeChannel({
  client,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  eventPayload: 'thin',

  // Path: /channels/stripe/webhook
  async webhook({ event }) {
    switch (event.type) {
      default:
        return;
    }
  },
});
```

The callback receives Stripe's native
`Stripe.V2.Core.EventNotification`. Application code may call
`event.fetchEvent()` or `event.fetchRelatedObject()` through the project-owned
client when it needs current data. Keep those API calls, credentials, and
authorization policy outside `@flue/stripe`.

Do not normalize snapshot events and thin notifications into one schema. They
have different provider semantics and SDK APIs.

Stripe's generated event unions describe the installed SDK version. Flue still
forwards a verified event type that is newer than those declarations. Until the
project upgrades Stripe, use `switch (event.type as string)` to observe that
future type and validate its resource fields in application code rather than
weakening every known event's native narrowing.

## Credentials and verification

`STRIPE_WEBHOOK_SECRET` verifies the exact request bytes and timestamp from the
`Stripe-Signature` header. `STRIPE_SECRET_KEY` authenticates outbound Stripe API
calls and initializes the project-owned SDK client. They are separate
credentials. Follow the project's secret conventions and never invent values.

Configure the Stripe event destination as:

```txt
https://example.com/channels/stripe/webhook
```

If `flue()` has an outer mount prefix, include it in the configured URL.
Subscribe only to event types the application handles.

The official Stripe SDK exposes a `workerd` implementation backed by Fetch and
Web Crypto. For Cloudflare projects, use the existing credential convention;
Flue's required `nodejs_compat` configuration supports `process.env`, and
typed Worker bindings remain an option. The completed project must execute
webhook verification and one fake-transport client request in workerd under
that configuration and pass its actual Cloudflare build.

Run the project's typecheck and configured Node and Cloudflare builds. Generate
original local snapshot and thin payloads with `Stripe-Signature` HMACs. Test
valid and tampered exact bytes, missing and stale signatures, payload-mode
mismatches, malformed and oversized bodies, `/channels/stripe/webhook`, and the
empty `200` default. Exercise one official SDK request through fake Fetch in
Node and workerd. Do not contact Stripe.

Stripe can deliver duplicates and does not guarantee ordering. Use `event.id`
as an event-level idempotency key in application-owned durable storage when
duplicate admission matters. Separate Stripe Event objects can still describe
the same resource change, so business operations must also be idempotent.

Do not use this ordinary webhook blueprint for synchronous real-time Issuing
authorization decisions. Event-destination registration, signing-secret
rotation, OAuth, API-key storage, ordering, replay recovery, and business
persistence remain application concerns.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
