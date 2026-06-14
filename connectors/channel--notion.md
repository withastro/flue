---
{
  "category": "channel",
  "website": "https://developers.notion.com"
}
---

# Add a Notion Channel to Flue

You are an AI coding agent adding verified Notion webhook ingress and
application-owned Notion API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
which Notion page or comment events the application needs.

Install `@flue/notion` and the official `@notionhq/client@5.22.0`. In a strict
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
input, page identity, and tool to the application:

```ts
import { Client } from '@notionhq/client';
import { createNotionChannel } from '@flue/notion';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

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

## Wire the agent

```ts
import { createAgent } from '@flue/runtime';
import { pageIdFromInstanceId, retrievePage } from '../channels/notion.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [retrievePage(pageIdFromInstanceId(id))],
}));
```

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Configure endpoint verification

Configure the exact webhook URL:

```txt
https://example.com/channels/notion/webhook
```

If `flue()` is mounted beneath an outer prefix, include it.

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
outside this recipe; validate any additional SDK operations the application
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

Run the project's typecheck and configured Node and Cloudflare builds. Create
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
