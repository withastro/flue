---
title: Notion
description: Receive signed Notion webhook events and use the official client from application-owned tools.
package:
  name: '@flue/notion'
  href: https://www.npmjs.com/package/@flue/notion
---

## Quickstart

Add verified webhook ingress and application-owned API behavior to an existing Flue project with the [Notion](https://developers.notion.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel notion
```

## Overview

The blueprint installs `@flue/notion`, the official `@notionhq/client`, and its
required TypeScript peer when needed. It creates
`<source-root>/channels/notion.ts` with a named `channel`, project-owned
`client`, local page identity helpers, and a page-bound retrieval tool, then
wires that tool into an agent. It may also add `"node"` to a restrictive
`compilerOptions.types` list.

```ts title="src/channels/notion.ts (abridged)"
import { Client } from '@notionhq/client';
import { createNotionChannel } from '@flue/notion';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const client = new Client({ auth: process.env.NOTION_TOKEN! });

export const channel = createNotionChannel({
  verificationToken: process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN!,
  async webhook({ event }) {
    if (event.type !== 'page.content_updated') return;

    await dispatch(assistant, {
      id: `notion-page:${encodeURIComponent(event.entity.id)}`,
      input: {
        type: `notion.${event.type}`,
        deliveryId: event.id,
        pageId: event.entity.id,
      },
    });
  },
});
```

A matching page update is admitted to the agent identified by that page, while
other verified events receive an empty successful response. The full generated
module handles additional page events, injects a Fetch implementation for Node
and Cloudflare portability, and lets the bound agent retrieve current page
state. Initial webhook verification uses a temporary setup callback, described
below, before recurring signed delivery can begin.

## Configure

| Variable                            | Purpose                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------- |
| `NOTION_WEBHOOK_VERIFICATION_TOKEN` | **Required after initial verification** — Verifies recurring webhook events after setup. |
| `NOTION_TOKEN`                      | **Required** — Authenticates outbound API calls.                                         |

It installs `@flue/notion` and the official
`@notionhq/client@5.22.0`. The blueprint creates a channel module with named
`channel` and `client` exports.

Configure the webhook URL as:

```txt
https://example.com/channels/notion/webhook
```

The webhook verification token and outbound API token are separate credentials.
During initial setup, use the `verification` callback described below to receive
and securely persist the webhook verification token.

The package declares `@types/node` as a required peer because the official
client's declarations import `node:http`. Add it as a development dependency
when the package manager does not install required peers automatically. This
is a type dependency and does not add Node code to a Worker bundle. If
`compilerOptions.types` is present, include `"node"` in that list.

## Channel module

```ts title="src/channels/notion.ts"
import { Client } from '@notionhq/client';
import { createNotionChannel } from '@flue/notion';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

const PAGE_INSTANCE_PREFIX = 'notion-page:';

const notionFetch: NonNullable<NonNullable<ConstructorParameters<typeof Client>[0]>['fetch']> = (
  url,
  init,
) =>
  globalThis.fetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });

const verificationToken = process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN || undefined;

export const client = new Client({
  auth: process.env.NOTION_TOKEN!,
  fetch: notionFetch,
});

export const channel = createNotionChannel({
  ...(verificationToken ? { verificationToken } : {}),

  // Initial setup only: temporarily use this instead of verificationToken and
  // persist the received value through the project's secure secret workflow.
  // async verification({ verificationToken }) {
  //   await saveNotionWebhookVerificationToken(verificationToken);
  // },

  // Path: /channels/notion/webhook
  async webhook({ event }) {
    switch (event.type) {
      case 'page.created':
      case 'page.content_updated':
      case 'page.properties_updated':
      case 'page.moved':
      case 'page.undeleted':
      case 'page.locked':
      case 'page.unlocked': {
        await dispatch(assistant, {
          id: pageInstanceId(event.entity.id),
          input: {
            type: `notion.${event.type}`,
            deliveryId: event.id,
            attemptNumber: event.attempt_number,
            pageId: event.entity.id,
            authors: event.authors,
            data: event.data,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrievePage(pageId: string) {
  return defineTool({
    name: 'retrieve_notion_page',
    description: 'Retrieve the Notion page bound to this agent.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
    async execute() {
      const page = await client.pages.retrieve({ page_id: pageId });
      return JSON.stringify({
        id: page.id,
        object: page.object,
        archived: 'archived' in page ? page.archived : undefined,
        inTrash: 'in_trash' in page ? page.in_trash : undefined,
      });
    },
  });
}

export function pageInstanceId(pageId: string): string {
  if (!pageId) throw new TypeError('Notion page id must be non-empty.');
  return `${PAGE_INSTANCE_PREFIX}${encodeURIComponent(pageId)}`;
}

export function pageIdFromInstanceId(id: string): string {
  if (!id.startsWith(PAGE_INSTANCE_PREFIX)) {
    throw new TypeError('Expected a local Notion page instance id.');
  }
  const pageId = decodeURIComponent(id.slice(PAGE_INSTANCE_PREFIX.length));
  if (!pageId) throw new TypeError('Expected a local Notion page instance id.');
  return pageId;
}
```

`event` is the official SDK's provider-native webhook payload union, so
`switch (event.type)` narrows each modeled variant to its snake-case payload
shape. The channel widens only `authors`/`accessible_by` to include Notion's
documented `agent` author type, which the current SDK type omits. A verified
event whose `type` is newer than the installed SDK is still forwarded — typed
as the union, with its native fields intact — and handled from the `default`
arm. There is no synthetic `type: 'unknown'` variant, `eventType`, or `raw`
mirror.

The `notion-page:` id is a local application convention because
`@flue/notion` does not invent one universal conversation key for unrelated
Notion resources. This example uses the page id because one project-owned
client selects the installation. Include workspace or installation identity
when one agent can cross credential domains.

## Bind the tool

```ts title="src/agents/assistant.ts"
import { defineAgent } from '@flue/runtime';
import { pageIdFromInstanceId, retrievePage } from '../channels/notion.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [retrievePage(pageIdFromInstanceId(id))],
}));
```

The model can request the current page summary, but it cannot select another
workspace, page, token, or API route. Trusted application code binds the page
from the verified event.

Notion webhook payloads intentionally describe a change rather than returning
all current resource state. Decide in application code whether an event should
trigger a page, block, comment, database, data-source, view, or file fetch.
Avoid retrieving every changed resource during ingress by default.

The example omits `page.deleted` because the bound retrieval tool may no longer
be able to read that page. Route deletion events to application persistence
when they matter. Comment events expose `event.data.page_id` and can use the
same local page identity when that matches the application's agent policy.

## Initial verification

Notion's first request is different from recurring event delivery. It is an
unsigned JSON object containing only `verification_token`, sent before a
signing secret exists.

Temporarily replace `verificationToken` in the example with the commented
`verification({ verificationToken })` callback. Persist the received token
through the project's secure secret workflow, then:

1. Set `NOTION_WEBHOOK_VERIFICATION_TOKEN`.
2. Redeploy with `verificationToken` enabled.
3. Remove the temporary setup callback.

Do not log or dispatch the verification token. The callback is setup code, not
authenticated application ingress. While no `verificationToken` is configured,
signed recurring events receive `503` and the `webhook` callback is not run.

For recurring events, Notion sends
`X-Notion-Signature: sha256=<hex-hmac>`. The package verifies HMAC-SHA256 over
the exact request bytes before parsing. The per-subscription signing token
already establishes the sending identity through signature verification, so the
channel exposes no separate workspace, subscription, or integration constraint
options.

## Delivery behavior

Notion can retry failed deliveries up to eight times with exponential backoff
and does not guarantee event ordering. `event.id` is the delivery id and
`event.attempt_number` identifies the retry attempt. Claim delivery ids in
application-owned durable storage before dispatch when duplicate admission is
unacceptable.

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body. A normal Hono or Fetch `Response` passes through unchanged. The
package does not impose an invented handler deadline.

The application owns webhook subscription creation, event selection, OAuth,
installation and token storage, deduplication, ordering recovery, resource
fetching, and outbound tools.

## Cloudflare Workers

Ordinary API calls through `@notionhq/client@5.22.0` use the injected Fetch and
execute in workerd with Flue's required `nodejs_compat` configuration. Use
`process.env` or typed Worker bindings according to the project's credential
convention, and verify the complete Worker build.

OAuth is outside this channel example. Validate any additional SDK operations
the application chooses to ship.

Test with original synthetic verification and event bodies. Generate local
HMAC signatures with Web Crypto, and exercise `Client.pages.retrieve()` through
an injected fake Fetch in Node and workerd. The fake transport should reject
unexpected URLs so tests cannot contact Notion.

See the [`@flue/notion` README](https://github.com/withastro/flue/tree/main/packages/notion#readme).
