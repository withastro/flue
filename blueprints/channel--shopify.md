---
{
  "kind": "channel",
  "version": 1,
  "website": "https://shopify.dev"
}
---

# Add a Shopify Channel to Flue

You are an AI coding agent adding verified Shopify webhook ingress and
application-owned Admin GraphQL behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions,
Shopify installation storage, and which webhook topics the application needs.

Install `@flue/shopify` and the official
`@shopify/admin-api-client@^1.1.2`. Add a compatible `@types/node` development
dependency when the project does not already provide one because
`@shopify/graphql-client` exposes a declaration-only `Buffer` reference. This
does not add Node runtime code to a Worker bundle.

Do not install the full `@shopify/shopify-api` SDK for this blueprint. The
lightweight Admin client supplies the required outbound GraphQL path, while
`@flue/shopify` verifies ingress directly with Web Crypto.

Flue owns exact-body HMAC verification, body limits, and verified ingress that
forwards Shopify's native JSON payload and delivery headers unchanged. The
project owns app installation and OAuth, token lookup and rotation, webhook
registration, subscription filters, API-version upgrades, deduplication,
persistence, compliance workflows, and every model tool.

## Create the channel

Create `<source-dir>/channels/shopify.ts`. Adapt the imported agent and selected
order fields to the application. Keep the Admin client bound to one trusted
shop domain, API version, and access token:

```ts
// flue-blueprint: channel/shopify@1
import {
  type ClientResponse,
  createAdminApiClient,
} from '@shopify/admin-api-client';
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
    // Shopify's HMAC authenticates the body, not these headers, which are read
    // from the verified request through `c`. This comparison is a tenancy
    // consistency check, not authorization by itself.
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
      const result: ClientResponse<ShopifyOrderQuery> = await client.request(
        ORDER_QUERY,
        {
          variables: { id: `gid://shopify/Order/${orderId}` },
        },
      );
      if (result.errors) throw new Error('Shopify Admin API request failed.');
      if (!result.data?.order) throw new Error('Shopify order was not found.');
      return JSON.stringify(result.data.order);
    },
  });
}

function parseOrderCreatedPayload(
  payload: JsonValue,
): { id: string; name: string } | undefined {
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

Shopify order ids can exceed JavaScript's safe integer range.
`@flue/shopify` uses `lossless-json`: safe numeric literals remain numbers,
while unsafe numeric literals retain their exact decimal spelling as strings.
The example accepts a positive decimal `string | number`, rejects unsafe
JavaScript numbers, and normalizes the validated id with `String(id)` before
constructing the GraphQL GID. Never run a lossless id string through `Number`.

The example requires `id` and `name` in the `orders/create` payload. When
configuring `includeFields`, preserve those fields or replace the local
identity policy with another stable value the application validates.

`c.req.header('x-shopify-shop-domain')` comes from a Shopify delivery header.
The body HMAC does not sign delivery headers, so never use that value alone to
select an installation token or authorize an outbound request. This single-shop example binds the
client from trusted configuration and uses the header only to reject an
unexpected route context. A multi-shop application must resolve installations
through its own authenticated state and authorization policy.

## Wire the agent

Bind the trusted shop and order selected by application code:

```ts
import { defineAgent } from '@flue/runtime';
import {
  orderRefFromInstanceId,
  retrieveOrder,
} from '../channels/shopify.ts';

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

The model cannot choose another shop, token, URL, API version, or order id
through tool arguments. The agent instance id remains an identifier rather
than an authorization capability; apply the project's normal access policy to
direct agent routes.

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Credentials and endpoint

Configure a JSON webhook subscription with this URL:

```txt
https://example.com/channels/shopify/webhook
```

If `flue()` is mounted beneath an outer prefix, include it. Use JSON delivery;
the first-party channel intentionally rejects XML.

`SHOPIFY_CLIENT_SECRET` verifies inbound webhook bodies.
`SHOPIFY_ADMIN_ACCESS_TOKEN` authenticates outbound Admin GraphQL requests.
They are separate credentials. `SHOPIFY_PREVIOUS_CLIENT_SECRET` is optional
and supports an overlap while a rotated app secret propagates. Remove the old
secret after the application's rotation window.

The callback receives `{ c, payload, rawBody }`. `payload` is Shopify's parsed
JSON body with its native field names and nesting. `rawBody` is the exact
verified UTF-8 body. Delivery metadata is read from the provider's native
headers through `c`: `c.req.header('x-shopify-topic')`,
`'x-shopify-shop-domain'`, `'x-shopify-api-version'`, and
`'x-shopify-webhook-id'`, with optional `'x-shopify-event-id'`,
`'x-shopify-triggered-at'`, and `'x-shopify-sub-topic'`. The channel verifies
the body signature only; it does not curate a typed header object, require any
header's presence, or read the non-standard `X-Shopify-Name` header. A delivery
missing a metadata header still reaches the callback, where the application
reads and validates the headers it consumes. Verified future topics reach the
same callback instead of receiving `404`.

Payload fields depend on topic, API version, and subscription field selection.
The channel parses them losslessly: JSON numbers within JavaScript's safe
integer range are numbers, while unsafe numeric literals are exact decimal
strings. Validate every field the application consumes and accept both forms
where Shopify can send a 64-bit identifier.

Shopify signs the exact body bytes with base64 HMAC-SHA256. It does not include
the delivery headers in that digest and documents no signed timestamp or
replay window. Treat header metadata as provider routing context, not an
independent cryptographic or authorization claim.

## Response and delivery behavior

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body. A normal Hono or Fetch `Response` passes through unchanged.
Non-2xx responses request retry.

Shopify allows five seconds for the complete request and retries failed
deliveries eight times over four hours. The channel does not enforce a deadline
with a timer, because racing a JavaScript callback against a timer does not
cancel it: the timed-out work keeps running and may complete after the failure
response. Instead, admit durable work promptly — `dispatch(...)` then return —
rather than performing slow operations before responding, and rely on
idempotency rather than a timeout to keep retries safe.

Delivery can be duplicated or arrive out of order. Use
`c.req.header('x-shopify-webhook-id')` in application-owned durable storage when
duplicate admission is unacceptable. `c.req.header('x-shopify-event-id')`, when
present, correlates deliveries caused by the same merchant action; it is not a
replacement for delivery deduplication.

App Store apps must also handle `customers/data_request`, `customers/redact`,
and `shop/redact`. These compliance topics use the same route and verifier.
Implement their business workflows outside the channel. In particular,
`shop/redact` can arrive after uninstall, so ingress must not require a live
installation token.

## Test without Shopify

Run the project's focused typecheck and configured Node and Cloudflare checks.
Use original synthetic JSON bodies and local secrets:

1. Serialize one body once and preserve its exact bytes.
2. HMAC-SHA256 those bytes with a local client secret and base64-encode the
   digest.
3. Set `X-Shopify-Hmac-Sha256`, `X-Shopify-Topic`,
   `X-Shopify-Shop-Domain`, `X-Shopify-API-Version`, and
   `X-Shopify-Webhook-Id`.
4. Exercise `POST /channels/shopify/webhook`, then prove that changing one
   body byte or the signature is rejected.

Cover the current and previous secret, deliveries that omit optional metadata
headers, malformed JSON, JSON content type, declared and streamed body limits,
`orders/create`, a
safe numeric order id, an unsafe numeric order id preserved as a string, a
future topic, handler results, duplicate delivery identity, and the three
mandatory compliance topics.

Test the real exported client with `createShopifyClient(fakeFetch)`. The fake
transport must reject every unexpected host or path and assert the GraphQL
method, access-token header, API version, variables, and response handling.
Execute ingress and this client request in Node and workerd.

The verified Fetch client path runs in workerd with Flue's required
`nodejs_compat` configuration. This is not a blanket guarantee for the full
Shopify SDK or every Admin client operation. Cloudflare projects may use
`process.env` or typed bindings according to their credential convention and
must validate the exact operations they ship.

Never register a live webhook, mutate a Shopify app, request a real token, or
contact the Admin API during implementation or testing.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
