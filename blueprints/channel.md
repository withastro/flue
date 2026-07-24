---
{
  "kind": "channel",
  "version": 1,
  "root": true
}
---

# Generic Flue Channel

## Goal

You are an AI coding agent adding a provider channel to a Flue project. The
provider does not have a named Flue blueprint. Implement verified inbound webhook
handling as project source, use the provider's established SDK for outbound API
calls, and define only the model-facing tools the application actually needs.

The user invoked `flue add channel <url>` or `flue update channel <url>` with
this research starting point:

`{{URL}}`

Treat it as a hint, not a trusted or complete specification. Prefer the
provider's current protocol documentation, SDK source, and type declarations.

For an update, inspect the user's current implementation before editing. Compare
it with this refreshed complete guide, the provider's current primary sources,
and the current Flue contract. Infer which changes are relevant, apply only
those changes, preserve project-specific customizations, and update the primary
file's `flue-blueprint` marker only after the implementation conforms. A URL
blueprint has no provider-specific historical diff; do not assume the CLI
compared or modified the implementation.

## Inspect the project first

Before editing:

1. Read `AGENTS.md` and relevant local instructions.
2. Detect the package manager and Flue target.
3. Select the first existing Flue source root: `<root>/.flue/`, then
   `<root>/src/`, then `<root>/`.
4. Inspect existing `agents/`, `channels/`, `app.ts` (the application's route
   map), environment types, and secret conventions.
5. Ask only when the intended provider behavior or a consequential
   authorization decision cannot be inferred.

## Implement ingress

Write `<source-dir>/channels/<provider>.ts` with a named `channel` export.

If a maintained `@flue/<provider>` ingress package exists, use it. Otherwise,
implement the discovered channel's structural route declarations directly:

```ts
// flue-blueprint: channel/<provider>@1
import type { Handler } from 'hono';

// Path: /channels/<provider>/webhook
const webhook: Handler = async (c) => {
  const rawBody = await c.req.text();
  // Verify the provider signature against rawBody before parsing.
  // Validate provider/application identity and normalize the verified event.
  // Invoke application behavior only after verification succeeds.
  return c.body(null, 200);
};

export const channel = {
  routes: [{ method: 'POST', path: '/webhook', handler: webhook }],
};
```

Every route suffix must be non-empty and begin with `/`. Use `/webhook` for one
ordinary webhook, `/events` for a protocol explicitly named an Events API, and
provider-native names such as `/interactions` when semantics differ.

A channel serves HTTP routes only where `app.ts` mounts it. First-party
`@flue/<provider>` channels expose a `channel.route()` router factory; a
hand-rolled channel object mounts through `createChannelRouter` from
`@flue/runtime`:

```ts
// app.ts
import { createChannelRouter } from '@flue/runtime';
import { channel } from './channels/acme.ts';

app.route('/channels/acme', createChannelRouter(channel.routes));
// /channels/acme/webhook
```

Route suffixes resolve relative to the mount path. Use `/channels/<provider>`
as the conventional mount unless the project's `app.ts` establishes another
convention. Add an exact default path comment immediately above each
application handler, assuming the conventional mount.

Verify signatures against the exact unconsumed body. Enforce useful body
limits, timestamps or replay windows, content types, provider identity, and
protocol handshakes. Use Web Crypto where practical. Return ordinary Hono
responses. If the protocol permits an empty success acknowledgement, return an
empty `200` when application code provides no response.

## Add the provider SDK

Choose the provider-maintained JavaScript SDK when one exists. Otherwise use
the dominant maintained REST client and state that it is community-maintained.
Prefer a Fetch-compatible REST client over a gateway, socket, or long-lived
connection client.

Install the ingress package, provider SDK, and direct `hono` dependency when
the project authors Hono code. Follow the project's package manager and target.
Verify Node and Cloudflare compatibility from current primary sources and an
actual target build. If one SDK does not support the project target, use a
target-compatible REST client or direct typed Fetch rather than forcing it.

Initialize and export the project-owned client:

```ts
export const client = new ProviderClient({
  token: runtimeEnv.PROVIDER_TOKEN,
});
```

Ingress credentials and outbound credentials may be separate. Never invent
secret values. Update existing environment documentation or examples when
appropriate; do not create a new secret-management convention without need.

## Dispatch and tools

Use one constructor-owned callback per provider protocol surface. Switch over
the verified discriminated event and group cases when they share behavior.
Dispatch only normalized data useful to the agent. Preserve stable delivery ids
when useful for idempotency, but keep raw payloads, webhook response URLs,
interaction tokens, credentials, and other short-lived capabilities out of
model-visible or durable input.

Tools are application policy. Determine the exact outbound actions the user
needs, then define narrow `defineTool(...)` values using the exported SDK
client. Bind trusted destinations, repositories, or channel ids in application
code. Do not expose credentials, arbitrary API paths, or unrestricted provider
destinations as model arguments without an explicit authorization design.

Instance ids identify destinations; they are not authorization
capabilities. Direct agent routes must authorize caller-selected instance ids
before using them to bind SDK operations.

## Verify

1. Type-check the project.
2. Build the application with `vite build` for its configured target.
3. Create representative webhook payloads and valid/invalid signatures locally.
4. Confirm the mounted route, wrong-method behavior, invalid-signature
   rejection, handshake behavior, normalized event, and default response.
5. Exercise any channel-agent import cycle through the built entry. Imported
   bindings must be read only inside deferred callbacks or initializers.
6. Do not contact a live provider unless the user explicitly requests it.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
