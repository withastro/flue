---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developer.salesforce.com/docs/marketing/marketing-cloud/guide/ens.html"
}
---

# Add a Salesforce Marketing Cloud Engagement Channel to Flue

You are an AI coding agent adding Salesforce Marketing Cloud Engagement Event
Notification Service (ENS) ingress and a narrow application-owned REST client
to a Flue project. This is not a generic Salesforce integration.

## Inspect the project

Read local instructions, detect the package manager and deployment target, and
select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Inspect existing agents, `app.ts` (the application's route
map), environment types, secret conventions, Marketing Cloud tenant
configuration, and the ENS event families the application subscribes to.

Install `@flue/salesforce`. Do not install
`@salesforce/core`: ingress and the narrow REST operation in this blueprint use
standard Fetch and Web Crypto in Node and Cloudflare Workers.

Flue owns exact-body signature verification, body and batch limits, minimal
common-field validation, and response serialization. The project owns callback
registration, `/platform/v1/ens-verify`, OAuth,
token storage and refresh, subscription lifecycle, event-family validation,
deduplication, persistence, agent routing policy, and every outbound
operation.

## Create the client

Create a small client such as
`<source-dir>/salesforce-marketing-cloud-client.ts`. Bind the tenant origin and
access token from trusted configuration:

```ts
export interface SalesforceMarketingCloudClientOptions {
  restBaseUrl: string;
  accessToken: string;
  fetcher?: typeof globalThis.fetch;
}

interface SalesforceMarketingCloudCallback {
  callbackId: string;
  callbackName: string;
  url: string;
  maxBatchSize: number;
  status: string;
  statusReason: string;
}

export function createSalesforceMarketingCloudClient({
  restBaseUrl,
  accessToken,
  fetcher = globalThis.fetch,
}: SalesforceMarketingCloudClientOptions) {
  const origin = salesforceMarketingCloudRestOrigin(restBaseUrl);
  if (!accessToken || accessToken.trim() !== accessToken) {
    throw new TypeError(
      'Salesforce Marketing Cloud access token must be non-empty and trimmed.',
    );
  }
  if (typeof fetcher !== 'function') {
    throw new TypeError('Salesforce Marketing Cloud Fetch must be callable.');
  }

  return {
    async getCallback(callbackId: string): Promise<SalesforceMarketingCloudCallback> {
      validateCallbackId(callbackId);
      const response = await fetcher(
        `${origin}/platform/v1/ens-callbacks/${encodeURIComponent(callbackId)}`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${accessToken}`,
          },
        },
      );
      if (!response.ok) {
        throw new Error(
          `Salesforce Marketing Cloud request failed with status ${response.status}.`,
        );
      }

      let value: unknown;
      try {
        value = await response.json();
      } catch {
        throw new TypeError('Salesforce Marketing Cloud returned invalid JSON.');
      }
      if (!isCallback(value) || value.callbackId !== callbackId) {
        throw new TypeError(
          'Salesforce Marketing Cloud returned an invalid callback response.',
        );
      }
      return value;
    },
  };
}

export function salesforceMarketingCloudRestOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError(
      'Salesforce Marketing Cloud REST base URL must be a valid URL.',
    );
  }

  const suffix = '.rest.marketingcloudapis.com';
  if (
    url.protocol !== 'https:' ||
    url.username !== '' ||
    url.password !== '' ||
    url.port !== '' ||
    url.pathname !== '/' ||
    url.search !== '' ||
    url.hash !== '' ||
    !url.hostname.endsWith(suffix) ||
    url.hostname.length === suffix.length ||
    !isDnsName(url.hostname)
  ) {
    throw new TypeError(
      'Salesforce Marketing Cloud REST base URL must be an HTTPS tenant origin ending in .rest.marketingcloudapis.com.',
    );
  }
  return url.origin;
}

function validateCallbackId(callbackId: string): void {
  if (!callbackId || callbackId.trim() !== callbackId) {
    throw new TypeError(
      'Salesforce Marketing Cloud callback id must be non-empty and trimmed.',
    );
  }
}

function isCallback(value: unknown): value is SalesforceMarketingCloudCallback {
  return (
    isRecord(value) &&
    isNonEmptyString(value.callbackId) &&
    isNonEmptyString(value.callbackName) &&
    isNonEmptyString(value.url) &&
    Number.isSafeInteger(value.maxBatchSize) &&
    (value.maxBatchSize as number) > 0 &&
    isNonEmptyString(value.status) &&
    isNonEmptyString(value.statusReason)
  );
}

function isDnsName(hostname: string): boolean {
  return hostname
    .split('.')
    .every(
      (label) =>
        label.length > 0 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
    );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
```

Accept only a tenant-specific HTTPS origin ending in
`.rest.marketingcloudapis.com`. Do not accept an arbitrary base URL from an
event, model, tool argument, or unsigned setup request. The access token and
tenant origin are separate from the ENS callback signature key.

The client intentionally demonstrates only callback lookup. Keep callback
creation, callback verification, subscription management, OAuth, token
refresh, and broader Marketing Cloud APIs outside this client.

## Create the channel

Create `<source-dir>/channels/salesforce-marketing-cloud.ts`. Adapt environment
access, the selected event families, and the dispatched message to the project:

```ts
// flue-blueprint: channel/salesforce-marketing-cloud@1
import {
  createSalesforceMarketingCloudChannel,
  type SalesforceMarketingCloudEvent,
} from '@flue/salesforce';
import { defineTool, dispatch, type JsonValue } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';
import { createSalesforceMarketingCloudClient } from '../salesforce-marketing-cloud-client.ts';
import {
  emailEventInstanceId,
  emailRefFromEvent,
  type SalesforceMarketingCloudEmailRef,
} from '../salesforce-marketing-cloud-email.ts';

const callbackId = requiredEnv('SALESFORCE_MARKETING_CLOUD_CALLBACK_ID');

export const client = createSalesforceMarketingCloudClient({
  restBaseUrl: requiredEnv('SALESFORCE_MARKETING_CLOUD_REST_BASE_URL'),
  accessToken: requiredEnv('SALESFORCE_MARKETING_CLOUD_ACCESS_TOKEN'),
});

export const channel = createSalesforceMarketingCloudChannel({
  signatureKey: requiredEnv('SALESFORCE_MARKETING_CLOUD_SIGNATURE_KEY'),
  callbackId,

  // Path: /channels/salesforce-marketing-cloud/events
  async events({ c, batch }) {
    const usefulEvents: Array<{
      event: SalesforceMarketingCloudEvent;
      ref: SalesforceMarketingCloudEmailRef;
    }> = [];

    for (const event of batch.events) {
      switch (event.eventCategoryType) {
        case 'TransactionalSendEvents.EmailSent':
        case 'TransactionalSendEvents.EmailNotSent':
        case 'TransactionalSendEvents.EmailBounced':
        case 'EngagementEvents.EmailOpen':
        case 'EngagementEvents.EmailClick':
        case 'EngagementEvents.EmailUnsubscribe': {
          const ref = emailRefFromEvent(callbackId, event);
          if (!ref) {
            return c.json(
              { error: 'Expected a supported Marketing Cloud email event.' },
              400,
            );
          }
          usefulEvents.push({ event, ref });
          break;
        }
        default:
          break;
      }
    }

    for (const { event, ref } of usefulEvents) {
      await dispatch(Assistant, {
        id: emailEventInstanceId(ref),
        // Recorded once when this event creates the instance; ignored after.
        initialData: {
          callbackId: ref.callbackId,
          mid: ref.mid,
          eid: ref.eid,
          jobId: ref.jobId,
          batchId: ref.batchId,
          listId: ref.listId,
          subscriberId: ref.subscriberId,
        },
        message: {
          kind: 'signal',
          type: `salesforce-marketing-cloud.${event.eventCategoryType}`,
          // `info` carries the family-specific event fields; there is no
          // natural message text for an engagement event.
          body: JSON.stringify(event.info ?? {}),
          attributes: {
            ...(typeof event.timestampUTC === 'string'
              ? { occurredAt: event.timestampUTC }
              : {}),
            callbackId: ref.callbackId,
            mid: ref.mid,
            eid: ref.eid,
            jobId: ref.jobId,
            batchId: ref.batchId,
            listId: ref.listId,
            subscriberId: ref.subscriberId,
          },
        },
      });
    }

    return c.body(null, 204);
  },
});

export function retrieveCallback(ref: SalesforceMarketingCloudEmailRef) {
  if (ref.callbackId !== callbackId) {
    throw new TypeError('Expected the configured Marketing Cloud callback.');
  }
  return defineTool({
    name: 'retrieve_salesforce_marketing_cloud_callback',
    description: 'Retrieve the Marketing Cloud ENS callback bound to this agent.',
    async run() {
      return (await client.getCallback(callbackId)) as unknown as JsonValue;
    },
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/salesforce-marketing-cloud.ts';

const app = new Hono();
app.route('/channels/salesforce-marketing-cloud', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comment in this guide assumes the
conventional `/channels/salesforce-marketing-cloud` mount; a different mount
path shifts every provider URL accordingly.

For each family, validate every provider-specific field before using it for
routing, authorization, persistence, or tool binding.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the validated email reference fields — the agent reads
them with `useInitialData()` instead of parsing the instance id. Per-message
facts stay on the signal's `attributes`.

The route is always `POST /events`. Signed notifications require
`SALESFORCE_MARKETING_CLOUD_SIGNATURE_KEY`. This is the opaque UTF-8 HMAC key
returned during callback creation. Do not base64-decode it. Only the
`x-sfmc-ens-signature` header is base64-decoded.

Unsigned callback verification is accepted only when the `verification`
handler is present. The body must contain exactly:

```json
{
  "callbackId": "provider-callback-id",
  "verificationKey": "one-time-verification-key"
}
```

Enable the handler only for the setup workflow that owns the callback, check
the configured `callbackId`, call `/platform/v1/ens-verify` from application
code, and then disable unsigned verification. Flue does not perform callback
registration, OAuth, or verification API calls automatically.

Do not add `verification` to the ordinary event-serving configuration above.
When setup is explicitly in scope, implement the application-owned call with
the same trusted tenant-origin and Bearer-token rules as the lookup client, and
test it only through injected fake Fetch.

## Create family identity

Create `<source-dir>/salesforce-marketing-cloud-email.ts` for the selected
email families. Validate `mid`, `eid`, and the family-specific fields under
`event.composite`, then serialize those values with `callbackId` into a
canonical local agent id. Provide matching functions such as:

```ts
emailRefFromEvent(
  callbackId: string,
  event: SalesforceMarketingCloudEvent,
): SalesforceMarketingCloudEmailRef | undefined;

emailEventInstanceId(ref: SalesforceMarketingCloudEmailRef): string;

parseEmailEventInstanceId(id: string): SalesforceMarketingCloudEmailRef;
```

Use positive decimal strings in the local reference so numeric and string ids
normalize consistently. Reject malformed or non-canonical ids. This identity
is application-defined for the selected email families; it is not a universal
ENS identity. Do not use deprecated `compositeId` for transactional email.

## Create the agent

Create an agent module such as `<source-dir>/agents/assistant.ts`:

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrieveCallback } from '../channels/salesforce-marketing-cloud.ts';

const initialDataSchema = v.object({
	callbackId: v.string(),
	mid: v.string(),
	eid: v.string(),
	jobId: v.string(),
	batchId: v.string(),
	listId: v.string(),
	subscriberId: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) {
		throw new Error(
			'This agent is created by the Salesforce Marketing Cloud channel dispatch.',
		);
	}
	useTool(retrieveCallback(data));
	return 'Review the inbound Salesforce Marketing Cloud email lifecycle event. Retrieve the configured ENS callback when callback status or delivery configuration is relevant.';
}

Assistant.initialData = initialDataSchema;
```

The `initialData` static validates the dispatched `initialData` when the
instance is created; `useInitialData()` returns the parsed value on every
render.

The `'use agent'` directive (the module's first statement) is what registers
the agent with the application — `dispatch(...)` from the channel callback
needs no `app.ts` mounting. Add
`app.route('/agents/<name>', createAgentRouter(Assistant))` (from
`@flue/runtime/routing`) in `app.ts` only when the agent
should also be reachable over HTTP directly.

The tool accepts no tenant origin, callback id, or access token from the
model. ENS does not provide a universal delivery id or conversation id. The
application-defined email id is valid only after the selected family fields
have been checked and remains an identifier rather than authorization.

## Configure the endpoint

Register the complete HTTPS callback URL in Marketing Cloud Engagement — the
channel's mount path in `app.ts` plus the route suffix, with the conventional
`app.route('/channels/salesforce-marketing-cloud', ...)` mount:

```txt
https://example.com/channels/salesforce-marketing-cloud/events
```

A different mount path changes the URL accordingly.

Marketing Cloud sends signed notification batches with:

```txt
x-sfmc-ens-signature: <base64 HMAC-SHA256 digest>
```

The HMAC input is the exact request body. The package verifies those bytes
before UTF-8 decoding or JSON parsing. The configured `signatureKey` is used
directly as UTF-8 key material.

Each signed payload is an ordered, nonempty JSON array with at most 1000
events. Ingress requires only a nonempty `eventCategoryType` on each event — a
single item without it is the only thing that fails the batch on event shape.
Every other field — `timestampUTC`, `compositeId`, `composite`,
`definitionKey`, `definitionId`, `mid`, `eid`, `info`, and any future field —
is forwarded exactly as Marketing Cloud delivered it, with the provider's own
names and nesting (`timestampUTC` is the provider UTC epoch in milliseconds and
is not validated). Narrow on `eventCategoryType` and read the family fields you
expect. The batch also exposes the exact decoded `rawBody`.

There is no common ENS delivery id, resource id, actor id, or conversation id.
Validate and compose application identity from the documented fields of each
subscribed event family.

## Response and delivery behavior

Returning nothing produces an empty `200`. A JSON-compatible value produces a
JSON `200`. A normal Hono or Fetch `Response` passes through unchanged. ENS
treats any status outside `200` through `204` as a delivery failure and
retries, so use a passthrough response outside that range only when redelivery
is intentional. A thrown callback or a non-serializable result returns `500`.

Marketing Cloud expects a prompt acknowledgement: it fails callback creation
if the verification POST is not answered with `200` within 30 seconds, and it
retries deliveries that are not acknowledged quickly. Admit durable work fast —
dispatch to an agent or enqueue, then return — instead of blocking on slow
operations before responding. Flue does not impose its own route timeout.

ENS delivery is at least once and retries can continue for up to seven days.
The channel does not deduplicate. Persist a family-appropriate application key
before performing non-idempotent work.

## Test without Salesforce

Run the project's strict typecheck, `vite build` for the configured target,
and actual workerd tests. Flue's canonical Cloudflare environment enables
`nodejs_compat`, while this ingress and client use standard Fetch, URL, and Web
Crypto APIs.

Create original synthetic ENS batches and local keys. Serialize each body
once, sign the unchanged bytes with HMAC-SHA256 using the opaque UTF-8 key,
then base64-encode only the digest. Cover:

- valid exact bytes and rejection after changing one byte;
- missing, malformed, and incorrect signatures;
- proof that `signatureKey` is not base64-decoded;
- the exact unsigned `{ callbackId, verificationKey }` setup shape;
- unsigned rejection when the verification handler is absent;
- callback-id mismatch;
- ordered batches of 1 and 1000 events, plus empty and oversized batches;
- required common fields and verbatim forwarding of optional and unmodeled
  family-dependent fields with their provider names and nesting;
- malformed UTF-8 and JSON, media type, and declared and streamed body limits;
- no-value, JSON, and normal `Response` results, including acknowledgment
  boundaries;
- application failure returning `500`.

Test the exported client in Node and workerd with injected fail-closed Fetch.
Assert:

- the exact trusted tenant origin;
- `GET /platform/v1/ens-callbacks/{callbackId}`;
- Bearer authorization;
- the exact `POST /platform/v1/ens-verify` body when setup verification is
  enabled;
- rejection of HTTP, credentials, ports, paths, and hosts outside
  `*.rest.marketingcloudapis.com`;
- no unexpected network destination is reached.

Never register or modify a live callback, subscribe to live events, perform
OAuth, request a real token, call `/ens-verify` against Salesforce, or contact
any Salesforce API during implementation or testing. Use only original
synthetic signed events and fake Fetch transports.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
