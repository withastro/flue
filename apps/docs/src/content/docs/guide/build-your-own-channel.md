---
title: Build a custom channel
description: Connect another provider with public Flue and web-platform primitives.
---

A channel is ordinary application code. You do not need a channel registration
API or generated route convention to connect another provider.

Use:

- a Fetch handler for ingress;
- Web Crypto or the provider's verified SDK for authentication;
- `dispatch(...)` for accepted agent input;
- `defineTool(...)` for controlled outbound actions;
- application-owned storage for installation credentials and deduplication.

## Verify before parsing

Provider signatures usually cover the original request bytes. Read the body
once, enforce a conservative size limit, verify the signature, then parse:

```ts title="src/channels/acme.ts"
const MAX_BODY_BYTES = 1024 * 1024;

async function handleWebhook(request: Request): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  const body = await readLimitedBody(request, MAX_BODY_BYTES);
  if (!body) return new Response(null, { status: 413 });

  const signature = request.headers.get('x-acme-signature');
  if (!signature || !(await verifyAcmeSignature(body, signature))) {
    return new Response(null, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    return new Response(null, { status: 400 });
  }

  return routeAcmeEvent(payload);
}

async function readLimitedBody(request: Request, limit: number): Promise<Uint8Array | undefined> {
  const declared = request.headers.get('content-length');
  if (declared && Number(declared) > limit) return undefined;
  if (!request.body) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
```

Do not parse and reserialize a signed body before verification. Define exact
method, path, content-type, malformed-body, and oversized-body responses.

## Return an unbound route factory

Expose a closure that can be mounted independently:

```ts
export const acme = {
  routes: {
    webhook: () => (request: Request) => handleWebhook(request),
  },
};
```

```ts title="src/app.ts"
app.mount('/webhooks/acme', acme.routes.webhook());
```

Avoid methods that depend on `this`; applications and routers commonly pass
handlers as unbound values.

## Give each event one owner

Treat handler registration like route ownership. Reject duplicate keys during
setup and return a registration-specific, idempotent unsubscribe function.
Explicit user code can fan out when needed.

For notification events, wait for required dispatch admission before returning
a successful acknowledgement:

```ts
await dispatch(assistant, {
  id: conversationKey(destination),
  input: {
    type: 'acme.message.created',
    deliveryId: payload.deliveryId,
    text: payload.text,
  },
});

return new Response(null, { status: 204 });
```

For interactions, define a small provider-native response union and validate it
before serialization. Document missing handlers, thrown handlers, invalid
responses, and deadline expiry.

## Separate identity from authority

A canonical conversation key can map a provider destination to an agent
instance:

```ts
function conversationKey(ref: AcmeThreadRef): string {
  return `acme:v1:${encodeURIComponent(ref.workspaceId)}:${encodeURIComponent(ref.threadId)}`;
}
```

Parsing this key proves only that it has the expected shape. It does not prove
that a caller may post to the destination. Direct routes must authorize
caller-selected ids independently.

## Pre-scope outbound tools

Keep credentials and destinations outside model arguments:

```ts
function replyInThread(ref: AcmeThreadRef) {
  const destination = { ...ref };

  return defineTool({
    name: 'acme_reply_in_thread',
    description: 'Reply in the bound Acme thread.',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', minLength: 1 },
      },
      required: ['text'],
      additionalProperties: false,
    },
    execute: async ({ text }, signal) => {
      await acmeClient.postMessage(destination, text, signal);
      return 'Reply posted.';
    },
  });
}
```

The client should use a fixed provider origin, reject absolute or
protocol-relative authenticated destinations, constrain redirects, propagate
caller aborts, apply a timeout, avoid automatic retries for writes, and redact
credentials from bounded errors.

## Test observable contracts

Protect the boundary users depend on:

- signed `Request` in, handler admission and provider `Response` out;
- exact-byte verification for non-canonical JSON and UTF-8 content;
- missing, malformed, and invalid signatures;
- body limits, content types, methods, and consumed bodies;
- duplicate registration and idempotent unsubscribe;
- replay behavior and surfaced delivery identity;
- canonical conversation-key round trips;
- authenticated provider requests from pre-scoped tools;
- target-runtime verification in workerd when Cloudflare is supported.

Use the first-party package tests under `packages/github`, `packages/slack`, and
`packages/discord` as concrete examples.
