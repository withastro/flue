---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developers.intercom.com"
}
---

# Add an Intercom Channel to Flue

You are an AI coding agent adding verified Intercom webhook ingress and
application-owned Intercom API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and deployment target, and
select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
then `<root>/`. Inspect existing agents, environment types, secret conventions,
Intercom installation storage, region selection, and the webhook topics the
application needs.

Install `@flue/intercom` and the official `intercom-client@^7.0.3` with the
project's package manager. Keep the SDK in project code; `@flue/intercom`
verifies ingress directly with Web Crypto and does not depend on the provider
client.

Flue owns endpoint validation, exact-body HMAC verification, body limits, and
the provider-native notification payload. The project owns app installation,
OAuth, permissions, workspace token lookup, webhook subscriptions,
deduplication, persistence, inbox policy, and every outbound tool.

## Create the client

Create a small project-owned client factory, for example
`<source-dir>/intercom-client.ts`. Adapt environment access to the target:

```ts
import { IntercomClient, IntercomEnvironment } from 'intercom-client';

export type IntercomRegion = 'us' | 'eu' | 'au';

export interface IntercomClientOptions {
  region?: IntercomRegion;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
}

export function createIntercomClient(
  token: string,
  options: IntercomClientOptions = {},
): IntercomClient {
  if (!token) throw new TypeError('Intercom access token must be non-empty.');
  return new IntercomClient({
    token,
    version: '2.14',
    environment: environmentForRegion(options.region ?? 'us'),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxRetries === undefined
      ? {}
      : { maxRetries: options.maxRetries }),
  });
}

function environmentForRegion(
  region: IntercomRegion,
): (typeof IntercomEnvironment)[keyof typeof IntercomEnvironment] {
  switch (region) {
    case 'us':
      return IntercomEnvironment.UsProduction;
    case 'eu':
      return IntercomEnvironment.EuProduction;
    case 'au':
      return IntercomEnvironment.AuProduction;
  }
}
```

Pin the client to API version `2.14`. The official SDK's generated request and
response types currently target that version even though newer webhook topic
documentation exists. Do not force a newer raw version header onto this client.
Choose the US, EU, or AU environment in trusted application configuration.

## Create the channel

Create `<source-dir>/channels/intercom.ts`. Adapt the imported agent,
conversation parser, dispatched input, and tool to the application:

```ts
// flue-blueprint: channel/intercom@1
import {
  createIntercomChannel,
  type IntercomConversationRef,
  type JsonValue,
} from '@flue/intercom';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createIntercomClient, type IntercomRegion } from '../intercom-client.ts';

const workspaceId = requiredEnv('INTERCOM_WORKSPACE_ID');

export const client = createIntercomClient(
  requiredEnv('INTERCOM_ACCESS_TOKEN'),
  { region: intercomRegion() },
);

export const channel = createIntercomChannel({
  clientSecret: requiredEnv('INTERCOM_CLIENT_SECRET'),

  // Path: /channels/intercom/webhook (HEAD, POST)
  async webhook({ notification }) {
    switch (notification.topic) {
      case 'conversation.user.created':
      case 'conversation.user.replied': {
        const conversationId = conversationIdFromItem(notification.data.item);
        if (!conversationId) return;

        const conversation: IntercomConversationRef = {
          workspaceId: notification.app_id,
          conversationId,
        };
        await dispatch(assistant, {
          id: channel.conversationKey(conversation),
          input: {
            type: `intercom.${notification.topic}`,
            notificationId: notification.id,
            createdAt: notification.created_at,
            deliveryAttempts: notification.delivery_attempts,
            conversation: notification.data.item,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveConversation(ref: IntercomConversationRef) {
  if (ref.workspaceId !== workspaceId) {
    throw new TypeError('Expected the configured Intercom workspace.');
  }
  return defineTool({
    name: 'retrieve_intercom_conversation',
    description: 'Retrieve the current Intercom conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const conversation = await client.conversations.find({
        conversation_id: ref.conversationId,
        display_as: 'plaintext',
      });
      return JSON.stringify(conversation);
    },
  });
}

function conversationIdFromItem(item: JsonValue): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  const id = item.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

function intercomRegion(): IntercomRegion {
  const value = process.env.INTERCOM_REGION || 'us';
  if (value === 'us' || value === 'eu' || value === 'au') return value;
  throw new Error('INTERCOM_REGION must be us, eu, or au.');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
```

The channel always publishes unsigned `HEAD /webhook` for Intercom's endpoint
check and signed `POST /webhook` for notifications. The callback runs only for
`POST`.

`INTERCOM_CLIENT_SECRET` verifies the exact inbound body.
`INTERCOM_ACCESS_TOKEN` authenticates project-owned REST API calls. They are
separate credentials. The HMAC-verified body already carries `app_id`, so the
channel does not re-check workspace identity; an app that serves multiple
workspaces filters on `notification.app_id` itself or routes on
application-owned installation state.

The callback receives Intercom's own notification object unchanged, with its
native field names and nesting: `notification.topic`, `notification.app_id`,
`notification.id`, `notification.created_at`, `notification.delivery_attempts`,
`notification.first_sent_at`, and the affected resource under
`notification.data.item`. Topic item schemas are broad and API-versioned, so
validate the fields used by each selected topic. Verified `ping`, currently
known topics, and future topics all reach the callback as open strings instead
of being rejected by a closed union.

## Wire the agent

Bind the verified workspace and conversation selected by trusted code:

```ts
import { defineAgent } from '@flue/runtime';
import { channel, retrieveConversation } from '../channels/intercom.ts';

export default defineAgent(({ id }) => {
  const conversation = channel.parseConversationKey(id);
  return {
    model: 'anthropic/claude-haiku-4-5',
    tools: [retrieveConversation(conversation)],
  };
});
```

The tool accepts no workspace, token, host, or conversation id from the model.
The canonical key is an identifier, not an authorization capability; apply the
project's normal access policy to direct agent routes. The channel-agent import
cycle is supported because imported bindings are read only inside deferred
callbacks and initializers.

## Configure the endpoint

Configure this complete HTTPS URL in Intercom's Developer Hub:

```txt
https://example.com/channels/intercom/webhook
```

If `flue()` has an outer mount prefix, include it. Intercom first sends an
unsigned `HEAD` request and expects `200`. Signed notifications then arrive by
`POST` with:

```txt
X-Hub-Signature: sha1=<40 hexadecimal characters>
```

Intercom computes HMAC-SHA1 over the exact request body with the developer app
client secret. The channel verifies those bytes before UTF-8 decoding or JSON
parsing. Intercom supplies no signed timestamp or replay window.

The notification carries `notification.id`, `notification.created_at`,
`notification.delivery_attempts`, and `notification.first_sent_at`. Pings may
have a null `id`. Use a non-null `id` in application-owned durable storage when
duplicate admission is unacceptable. Deliveries can be duplicated or arrive
out of order.

Returning nothing produces an empty `200`; any other non-`Response` value is
serialized with `Response.json()`. A normal Hono or Fetch `Response` passes
through. Intercom acknowledges on any `2xx`, but `410` disables the
subscription and `429` throttles it, so prefer `200` unless redelivery,
throttling, or subscription disablement is intentional. A thrown callback
surfaces to the framework error handler as `500`.

Intercom expects a `2xx` within about five seconds and otherwise retries the
notification once after one minute. The channel does not enforce this with a
timer (a timer cannot cancel running JavaScript). Instead, admit durable work
quickly — dispatch and return — and rely on `notification.id` for idempotency
rather than blocking the callback on slow operations.

## Test without Intercom

Run the project's typecheck, Node build, Cloudflare build, and actual workerd
tests. Flue projects already enable `nodejs_compat`; execute both ingress and
the official client in that configuration rather than treating bundling as
runtime proof.

Use an original synthetic notification and a local test secret. Serialize the
body once, then sign those unchanged bytes:

```ts
async function intercomSignature(secret: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign'],
  );
  const digest = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, encoder.encode(body)),
  );
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return `sha1=${hex}`;
}
```

Cover:

- `HEAD /channels/intercom/webhook` returning an empty `200`;
- a valid signed notification and rejection after changing one body byte;
- missing, malformed, and invalid signatures;
- `ping`, selected conversation topics, and an original future topic;
- malformed JSON, media type, declared and streamed body limits;
- no-value, JSON, and normal `Response` results;
- a thrown callback surfacing as `500`, and canonical conversation-key round trip.

Test the real exported client with an injected fail-closed Fetch transport in
both Node and workerd:

```ts
const fakeFetch: typeof fetch = async (input, init) => {
  const request = new Request(input, init);
  if (
    request.url !==
    'https://api.intercom.io/conversations/conversation-test?display_as=plaintext'
  ) {
    throw new Error(`Unexpected network destination: ${request.url}`);
  }
  if (request.method !== 'GET') throw new Error('Unexpected method.');
  if (request.headers.get('authorization') !== 'Bearer local-test-token') {
    throw new Error('Unexpected authorization.');
  }
  if (request.headers.get('intercom-version') !== '2.14') {
    throw new Error('Unexpected API version.');
  }
  return Response.json({
    type: 'conversation',
    id: 'conversation-test',
    title: 'Synthetic support request',
  });
};

const testClient = createIntercomClient('local-test-token', {
  fetch: fakeFetch,
  maxRetries: 0,
});
```

Stub any unconfigured global network path to throw and assert that the injected
transport is called exactly once. Use `nodejs_compat` for workerd execution and
confirm the official client identifies that runtime correctly.

Never register or modify a live webhook, install an app, perform OAuth, request
a real token, or contact an Intercom API during implementation or testing.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
