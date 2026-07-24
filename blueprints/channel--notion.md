---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developers.notion.com"
}
---

# Add a Notion Channel to Flue

You are an AI coding agent adding verified Notion webhook ingress and
application-owned Notion API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and which Notion page or comment events
the application needs.

Install `@flue/notion` and the official `@notionhq/client@^5.22.0`. In a strict
TypeScript project, keep the compatible `@types/node` peer available because
the official client's declarations import `node:http`, even when the runtime
uses Fetch. Add it as a development dependency when the package manager does
not install required peers automatically. If the project's `tsconfig.json`
limits `compilerOptions.types`, include `"node"` there.

Flue owns exact-body signature verification and typed ingress. The project
owns the official client, OAuth and installation lifecycle, webhook
subscription creation, token storage, event selection, deduplication,
ordering, resource-fetching policy, and every outbound tool.

## Create the channel

Create `<source-dir>/channels/notion.ts`. Adapt the imported agent, dispatched
message, page identity, and tool to the application:

```ts
// flue-blueprint: channel/notion@1
import { Client } from '@notionhq/client';
import { createNotionChannel } from '@flue/notion';
import { defineTool, dispatch } from '@flue/runtime';
import { Assistant } from '../agents/assistant.ts';

const PAGE_INSTANCE_PREFIX = 'notion-page:';

const notionFetch: NonNullable<
  NonNullable<ConstructorParameters<typeof Client>[0]>['fetch']
> = (url, init) =>
  globalThis.fetch(url, {
    method: init?.method,
    headers: init?.headers,
    body: init?.body,
  });

const verificationToken =
  process.env.NOTION_WEBHOOK_VERIFICATION_TOKEN || undefined;

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
        await dispatch(Assistant, {
          id: pageInstanceId(event.entity.id),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            pageId: event.entity.id,
          },
          message: {
            kind: 'signal',
            type: `notion.${event.type}`,
            // `data` is Notion's event-specific detail object; page events
            // carry no natural message text.
            body: JSON.stringify(event.data ?? {}),
            attributes: {
              eventId: event.id,
              pageId: event.entity.id,
              attemptNumber: String(event.attempt_number),
              authorIds: event.authors.map((author) => author.id).join(','),
            },
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
    async run() {
      const page = await client.pages.retrieve({ page_id: pageId });
      return {
        id: page.id,
        object: page.object,
        archived: 'archived' in page ? page.archived : undefined,
        inTrash: 'in_trash' in page ? page.in_trash : undefined,
      };
    },
  });
}

export function pageInstanceId(pageId: string): string {
  if (!pageId) throw new TypeError('Notion page id must be non-empty.');
  return `${PAGE_INSTANCE_PREFIX}${encodeURIComponent(pageId)}`;
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/notion.ts';

const app = new Hono();
app.route('/channels/notion', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/notion` mount; a different mount path shifts every
provider URL accordingly.

The page identity helper is application code, not a capability supplied by
Notion or `@flue/notion`. The example uses Notion's page id because one
project-owned client selects the installation. Add verified workspace or
installation identity to the local id when the application serves multiple
credential domains. Do not treat workspace, subscription, integration, page,
or delivery ids as authorization for outbound API calls.

The tool accepts no page id from the model. Trusted code binds the page selected
by the verified event. Fetch only the current resource fields the application
needs; do not automatically retrieve every changed page during webhook
handling.

The example omits `page.deleted` because its bound retrieval tool may no longer
be able to read that page. Route deletion events to application persistence
when they matter. Comment events expose `event.data.page_id`; group the selected
comment cases into the same local page identity only when that matches the
application's agent policy.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the page id the agent's tool binds to — the agent reads
it with `useInitialData()` instead of parsing the instance id. Per-message
facts stay on the signal's `attributes`.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { retrievePage } from '../channels/notion.ts';

const initialDataSchema = v.object({
	pageId: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Notion channel dispatch.');
	useTool(retrievePage(data.pageId));
	return 'Review the Notion page change. Retrieve the current page when its properties are needed.';
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

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and agent function bodies.

## Configure endpoint verification

Configure the exact webhook URL — the channel's mount path in `app.ts` plus
the route suffix, with the conventional
`app.route('/channels/notion', ...)` mount:

```txt
https://example.com/channels/notion/webhook
```

A different mount path changes the URL accordingly.

Notion first sends one unsigned JSON object containing `verification_token`.
This request is setup traffic, not authenticated application ingress. To
capture it:

1. Temporarily replace `verificationToken` with the commented
   `verification({ verificationToken })` callback.
2. Persist the value through the project's secure secret-management workflow.
3. Set `NOTION_WEBHOOK_VERIFICATION_TOKEN` and redeploy with `verificationToken`
   enabled.
4. Remove the temporary setup callback.

Do not log the token, dispatch it to an agent, or leave setup capture enabled as
ordinary event handling. While only the setup callback is configured, signed
events receive `503` because no HMAC secret is available.

Recurring events include `X-Notion-Signature:
sha256=<hex-hmac>`. `@flue/notion` verifies the exact request bytes with the
stored verification token before parsing. The per-subscription signing token
already establishes identity through signature verification, so the channel
exposes no separate workspace, subscription, or integration constraint options.

`NOTION_TOKEN` authenticates outbound API calls and is distinct from
`NOTION_WEBHOOK_VERIFICATION_TOKEN`. OAuth authorization, token exchange,
installation storage, refresh or rotation policy, and workspace-specific
client selection remain application concerns.

## Runtime and delivery behavior

Ordinary `@notionhq/client` API calls use the injected Fetch implementation and
execute in workerd with Flue's required `nodejs_compat` configuration. OAuth is
outside this blueprint; validate any additional SDK operations the application
chooses to ship.

Events are delivered as the official SDK's provider-native webhook payload
types. Modeled `type` values narrow to the matching SDK payload shape; the
channel widens only `authors`/`accessible_by` to include Notion's documented
`agent` principal type, which the current SDK type omits. Any authenticated
event type the installed SDK does not yet model is still forwarded with its
native snake-case fields — handle it from a `default` arm after the `type`
values you care about.

Notion can retry failed deliveries up to eight times with exponential backoff
and does not guarantee ordering. Use `event.id` in application-owned durable
storage before dispatch when duplicate admission is unacceptable. The channel
does not persist ids, reorder events, or fetch current resource state.

Returning nothing produces an empty `200`. A JSON-compatible value becomes the
response body. A normal Hono or Fetch `Response` passes through unchanged.

## Test without Notion

Run the project typecheck and `vite build` for the configured target. Create
original synthetic payloads and test:

- the unsigned one-field verification request and secure capture path;
- valid and tampered exact-body HMAC-SHA256 signatures;
- missing or malformed signatures;
- grouped page cases, selected comment cases, retries, and forwarding of
  authenticated event types the installed SDK does not yet model;
- malformed JSON, content type, body limits, and handler response behavior;
- the exact `/channels/notion/webhook` route;
- one real `Client.pages.retrieve()` call through an injected fake Fetch
  transport in Node and workerd.

The fake transport must fail if a request escapes its expected local URL.
Do not create a live subscription or contact Notion from tests.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
