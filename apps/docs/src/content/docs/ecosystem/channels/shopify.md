---
title: Shopify
description: Receive verified Shopify webhooks and use a shop-bound Admin GraphQL client from application-owned tools.
package:
  name: '@flue/shopify'
  href: https://www.npmjs.com/package/@flue/shopify
---

## Quickstart

Add verified Shopify webhook ingress and application-owned Admin GraphQL behavior to an existing Flue project with the [Shopify](https://shopify.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel shopify
```

## Overview

The blueprint installs `@flue/shopify` and the official lightweight
`@shopify/admin-api-client`, creates a source-root `channels/shopify.ts` module
with named `channel` and project-owned `client` exports, and modifies the
selected orders agent to bind a generated Admin GraphQL tool. It also adds
`@types/node` when the project needs the Admin client's declaration-only
`Buffer` type.

```ts title="src/channels/shopify.ts (abridged)"
import { createAdminApiClient } from '@shopify/admin-api-client';
import { createShopifyChannel } from '@flue/shopify';
import { dispatch } from '@flue/runtime';
import orders from '../agents/orders.ts';

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;

export const client = createAdminApiClient({
  storeDomain: SHOP_DOMAIN,
  apiVersion: '2026-04',
  accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!,
});

export const channel = createShopifyChannel({
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
  previousClientSecret: process.env.SHOPIFY_PREVIOUS_CLIENT_SECRET || undefined,
  async webhook({ c, payload }) {
    const shopDomain = c.req.header('x-shopify-shop-domain');
    if (shopDomain !== SHOP_DOMAIN) {
      return c.json({ error: 'Unexpected Shopify shop.' }, 403);
    }
    if (c.req.header('x-shopify-topic') !== 'orders/create') return;

    const order = parseOrderCreatedPayload(payload);
    if (!order) return c.json({ error: 'Unsupported orders/create payload.' }, 400);
    await dispatch(orders, {
      id: orderInstanceId(shopDomain, order.id),
      input: { type: 'shopify.orders.create', orderId: order.id, orderName: order.name },
    });
  },
});
```

The abridged example omits the generated payload parser, order-instance helpers,
and Admin GraphQL tool. Once configured, an `orders/create` delivery continues
the agent instance bound to that trusted shop and order, and the tool can
retrieve that order without letting the model choose a shop, token, or order id.
The same verified Fetch path runs on Node and Cloudflare Workers with Flue's
`nodejs_compat` setting.

## Configure

| Variable                         | Purpose                                                                |
| -------------------------------- | ---------------------------------------------------------------------- |
| `SHOPIFY_CLIENT_SECRET`          | **Required** — Verifies inbound request bodies.                        |
| `SHOPIFY_PREVIOUS_CLIENT_SECRET` | **Optional** — Verifies deliveries during a secret-rotation overlap.   |
| `SHOPIFY_ADMIN_ACCESS_TOKEN`     | **Required** — Authenticates outbound Admin GraphQL requests.          |
| `SHOPIFY_SHOP_DOMAIN`            | **Required** — Binds the client and inbound tenancy check to one shop. |

It installs `@flue/shopify` and the official lightweight
`@shopify/admin-api-client@1.1.2`. The blueprint creates a channel module with
named `channel` and project-owned `client` exports.

Configure a JSON webhook subscription with this URL:

```txt
https://example.com/channels/shopify/webhook
```

The inbound client secret and outbound Admin access token are separate
credentials.

The Admin client's public declarations include a `Buffer` reference through
`@shopify/graphql-client`. Add a compatible `@types/node` development
dependency when the project does not already provide one. It is a type-only
requirement and does not add Node runtime code to a Worker.

## Channel module

```ts title="src/channels/shopify.ts"
import { type ClientResponse, createAdminApiClient } from '@shopify/admin-api-client';
import { createShopifyChannel, type JsonValue } from '@flue/shopify';
import { defineTool, dispatch } from '@flue/runtime';
import orders from '../agents/orders.ts';

const SHOP_DOMAIN = process.env.SHOPIFY_SHOP_DOMAIN!;
const ADMIN_API_VERSION = '2026-04';
const ORDER_INSTANCE_PREFIX = 'shopify-order:';

export function createShopifyClient(customFetchApi: typeof fetch = globalThis.fetch) {
  return createAdminApiClient({
    storeDomain: SHOP_DOMAIN,
    apiVersion: ADMIN_API_VERSION,
    accessToken: process.env.SHOPIFY_ADMIN_ACCESS_TOKEN!,
    customFetchApi,
  });
}

export const client = createShopifyClient();

export const channel = createShopifyChannel({
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
  previousClientSecret: process.env.SHOPIFY_PREVIOUS_CLIENT_SECRET || undefined,

  // Path: /channels/shopify/webhook
  async webhook({ c, payload }) {
    // Shopify's HMAC authenticates the body, not these headers, which are
    // read from the verified request through `c`. This comparison is a
    // tenancy consistency check, not authorization by itself.
    const shopDomain = c.req.header('x-shopify-shop-domain');
    if (shopDomain !== SHOP_DOMAIN) {
      return c.json({ error: 'Unexpected Shopify shop.' }, 403);
    }

    switch (c.req.header('x-shopify-topic')) {
      case 'orders/create': {
        const order = parseOrderCreatedPayload(payload);
        if (!order) {
          return c.json({ error: 'Unsupported orders/create payload.' }, 400);
        }

        await dispatch(orders, {
          id: orderInstanceId(shopDomain, order.id),
          input: {
            type: 'shopify.orders.create',
            deliveryId: c.req.header('x-shopify-webhook-id'),
            eventId: c.req.header('x-shopify-event-id'),
            shopDomain,
            apiVersion: c.req.header('x-shopify-api-version'),
            orderId: order.id,
            orderName: order.name,
            triggeredAt: c.req.header('x-shopify-triggered-at'),
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

const ORDER_QUERY = `#graphql
  query BoundOrder($id: ID!) {
    order(id: $id) {
      id
      name
      displayFinancialStatus
      displayFulfillmentStatus
      totalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
    }
  }
`;

interface ShopifyOrderQuery {
  order: {
    id: string;
    name: string;
    displayFinancialStatus: string | null;
    displayFulfillmentStatus: string;
    totalPriceSet: {
      shopMoney: {
        amount: string;
        currencyCode: string;
      };
    };
  } | null;
}

export function retrieveOrder(orderId: string) {
  return defineTool({
    name: 'retrieve_shopify_order',
    description: 'Retrieve the Shopify order already bound to this agent.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const result: ClientResponse<ShopifyOrderQuery> = await client.request(ORDER_QUERY, {
        variables: { id: `gid://shopify/Order/${orderId}` },
      });
      if (result.errors) throw new Error('Shopify Admin API request failed.');
      if (!result.data?.order) throw new Error('Shopify order was not found.');
      return JSON.stringify(result.data.order);
    },
  });
}

function parseOrderCreatedPayload(payload: JsonValue): { id: string; name: string } | undefined {
  if (!isRecord(payload) || !isOrderId(payload.id)) return undefined;
  if (typeof payload.name !== 'string' || payload.name.length === 0) {
    return undefined;
  }
  return { id: String(payload.id), name: payload.name };
}

function isOrderId(value: unknown): value is string | number {
  if (typeof value === 'string') return /^[1-9]\d*$/.test(value);
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

function isRecord(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function orderInstanceId(shopDomain: string, orderId: string): string {
  if (!shopDomain || !orderId) {
    throw new TypeError('Shopify shop domain and order id must be non-empty.');
  }
  return `${ORDER_INSTANCE_PREFIX}${encodeURIComponent(shopDomain)}:${encodeURIComponent(orderId)}`;
}

export function orderRefFromInstanceId(id: string): {
  shopDomain: string;
  orderId: string;
} {
  if (!id.startsWith(ORDER_INSTANCE_PREFIX)) {
    throw new TypeError('Expected a local Shopify order instance id.');
  }
  const encoded = id.slice(ORDER_INSTANCE_PREFIX.length);
  const separator = encoded.indexOf(':');
  if (separator < 1) {
    throw new TypeError('Expected a local Shopify order instance id.');
  }
  let shopDomain: string;
  let orderId: string;
  try {
    shopDomain = decodeURIComponent(encoded.slice(0, separator));
    orderId = decodeURIComponent(encoded.slice(separator + 1));
  } catch {
    throw new TypeError('Expected a local Shopify order instance id.');
  }
  if (!shopDomain || !orderId) {
    throw new TypeError('Expected a local Shopify order instance id.');
  }
  return { shopDomain, orderId };
}
```

The client binds one trusted shop domain, access token, and explicit Admin API
version. The tool accepts no destination from the model. A multi-shop
application should resolve installation credentials from its own authenticated
state instead of selecting them from webhook headers or tool input.

The example validates `id` and `name` from `orders/create`. Preserve those
fields when using Shopify's `includeFields` subscription option, or define
another validated application identity.

Shopify order ids can exceed JavaScript's safe integer range. The guard accepts
positive decimal strings and positive safe integers, then immediately
normalizes the value with `String(id)`. It never coerces an unsafe decimal
string through `Number`.

## Bind the tool

```ts title="src/agents/orders.ts"
import { defineAgent } from '@flue/runtime';
import { orderRefFromInstanceId, retrieveOrder } from '../channels/shopify.ts';

export default defineAgent(({ id }) => {
  const { shopDomain, orderId } = orderRefFromInstanceId(id);
  if (shopDomain !== process.env.SHOPIFY_SHOP_DOMAIN) {
    throw new TypeError('Unexpected Shopify shop.');
  }
  return {
    model: 'anthropic/claude-haiku-4-5',
    tools: [retrieveOrder(orderId)],
  };
});
```

The local `shopify-order:` id includes shop and order identity because Shopify
has no universal conversation key. It is still an identifier, not an
authorization capability. Apply normal access control to direct agent routes.

## Verification and event shape

Shopify computes base64 HMAC-SHA256 over the exact request body.
`@flue/shopify` verifies those bytes before decoding or parsing JSON. The
first-party channel supports JSON subscriptions only; XML receives `415`.

The callback receives `{ c, payload, rawBody }`: the Hono context, the parsed
JSON `payload`, and the exact verified `rawBody`. Delivery metadata is read from
the provider's native headers through `c`:

- `c.req.header('x-shopify-topic')`, `'x-shopify-shop-domain'`,
  `'x-shopify-api-version'`, and `'x-shopify-webhook-id'`;
- optional `'x-shopify-event-id'`, `'x-shopify-triggered-at'`, and
  `'x-shopify-sub-topic'`.

The channel verifies the body signature only; it does not curate a typed header
object, require any header's presence, or read the non-standard `X-Shopify-Name`
header. A delivery missing a metadata header still reaches the callback, where
the application reads and validates the headers it consumes from `c`.

Topics remain provider-native strings such as `orders/create`. Future verified
topics reach the callback instead of being rejected because the installed
package does not recognize a closed topic union.

`@flue/shopify` parses the payload with `lossless-json`. Numeric literals that
fit JavaScript's safe integer range remain numbers. Unsafe numeric literals,
including 64-bit Shopify identifiers, retain their exact decimal spelling as
strings instead of being rounded. Validate the fields used by each topic and
accept `string | number` where an identifier may appear in either form.

The HMAC covers only the body, not Shopify's delivery headers. Treat
`shopDomain`, version, topic, and delivery metadata as provider-supplied routing
context, not an independently signed authorization claim. Shopify also
documents no signed timestamp or webhook replay window.

Use `previousClientSecret` during an app-secret rotation overlap:

```ts
createShopifyChannel({
  clientSecret: process.env.SHOPIFY_CLIENT_SECRET!,
  previousClientSecret: process.env.SHOPIFY_PREVIOUS_CLIENT_SECRET || undefined,
  webhook({ c, payload }) {
    // ...
  },
});
```

Remove the previous secret after the application's rotation window.

## Responses, retries, and ordering

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. A normal Hono or Fetch `Response` passes through unchanged.
Non-2xx responses ask Shopify to retry.

Shopify allows five seconds for the complete delivery. The channel does not
enforce a deadline with a timer, because racing a JavaScript callback against a
timer cannot cancel it: the timed-out work keeps running and may complete after
the failure response. Admit durable work promptly — dispatch and return —
rather than performing slow operations before responding, and schedule
long-running processing outside the webhook response path. A thrown callback
propagates to Hono's error handler.

Shopify retries failed HTTPS deliveries eight times over four hours. Deliveries
can be duplicated or arrive out of order. Use
`c.req.header('x-shopify-webhook-id')` in application-owned durable storage for
delivery deduplication, relying on idempotency rather than a timeout to keep
retries safe. Optional `c.req.header('x-shopify-event-id')` correlates separate
deliveries caused by the same merchant action; it does not replace the webhook
id.

The channel does not register subscriptions, persist delivery ids, restore
ordering, manage installation tokens, or infer a conversation or resource key.

## Compliance topics

App Store apps must process:

- `customers/data_request`;
- `customers/redact`;
- `shop/redact`.

These topics use the same `/channels/shopify/webhook` route and verification
path. Their required business actions remain application-owned.
`shop/redact` can arrive after uninstall, so webhook verification must not
depend on a live Admin API token.

## Cloudflare Workers

The direct Web Crypto verifier and the ordinary Fetch request path from
`@shopify/admin-api-client@1.1.2` execute in Node and workerd with Flue's
required `nodejs_compat` configuration. This is evidence for the client
operation shown here, not a blanket guarantee for the full
`@shopify/shopify-api` SDK or every helper in the Admin client.

Cloudflare projects may initialize secrets through `process.env` or typed
Worker bindings. Test the exact GraphQL operations used by the application
against its Worker target.

Create original synthetic webhook bodies and locally generated HMACs. Cover
valid and tampered exact bytes, current and previous secrets, deliveries that
omit optional metadata headers, safe and unsafe numeric identifiers, unknown
topics, malformed JSON, body limits, and handler results. Test
`createShopifyClient(fakeFetch)` in Node and workerd with a fake transport that
rejects unexpected hosts and paths. No test should register a webhook or
contact Shopify.

See the [`@flue/shopify` README](https://github.com/withastro/flue/tree/main/packages/shopify#readme).
