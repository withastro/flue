---
{
  "kind": "channel",
  "version": 1,
  "website": "https://developers.facebook.com/docs/messenger-platform"
}
---

# Add a Facebook Messenger Channel to Flue

You are an AI coding agent adding verified Facebook Messenger Page webhook
ingress and project-owned outbound Graph API access to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and the Facebook Page the application
owns.

Install `@flue/messenger`. Flue owns GET verification, exact-body
`X-Hub-Signature-256` validation, fixed Page identity, the provider-native
payload, and canonical instance ids. The project owns Page access tokens,
outbound Graph API behavior, tools, dispatch policy, and durable duplicate
admission.

Do not install a Node-only Facebook or Messenger SDK in a Cloudflare project.
The official JavaScript Business SDK targets the Marketing API and uses
Node-oriented Axios behavior. Current Messenger-specific community clients do
not establish a browser or Workers support contract. Use a small
standards-based Graph API Fetch client in project code and test every operation
the application relies on in Node and workerd.

Install `valibot` using the project's existing dependency conventions.

## Create a Graph client

Create `<source-dir>/messenger-client.ts`. Implement a project-owned
`MessengerClient` with:

- `pageId`, `pageAccessToken`, optional `graphVersion`, optional `fetch`, and
  optional `apiBaseUrl` constructor options;
- a generic `request<T>(path, options)` method for application-owned Graph
  operations;
- `client.messages.send(...)` for arbitrary supported Messenger message
  objects;
- `client.messages.sendText(...)` for ordinary replies;
- `client.senderActions.send(...)` for `mark_seen`, typing, and reaction
  actions;
- `POST /v25.0/{PAGE_ID}/messages`;
- the Page access token sent through Meta's documented `access_token`
  parameter;
- JSON request and response handling with provider error propagation.

Use global `fetch`, `URL`, and `Response`. Do not add Node-only polyfills. Keep
the access token out of logs and model-visible data. The repository example at
`examples/messenger-channel/` shows the expected project-owned shape, but
adapt it to the project's actual operations.

## Create the channel

Create `<source-dir>/channels/messenger.ts`. Adapt the imported agent,
dispatched message, and tool:

```ts
// flue-blueprint: channel/messenger@1
import {
  createMessengerChannel,
  type MessengerConversationRef,
} from '@flue/messenger';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';
import { MessengerClient } from '../messenger-client.ts';

export const client = new MessengerClient({
  pageId: process.env.MESSENGER_PAGE_ID!,
  pageAccessToken: process.env.MESSENGER_PAGE_ACCESS_TOKEN!,
  graphVersion: 'v25.0',
});

export const channel = createMessengerChannel({
  appSecret: process.env.MESSENGER_APP_SECRET!,
  verifyToken: process.env.MESSENGER_VERIFY_TOKEN!,
  pageId: process.env.MESSENGER_PAGE_ID!,

  // Paths: GET and POST /channels/messenger/webhook
  async webhook({ payload }) {
    for (const entry of payload.entry) {
      for (const event of entry.messaging ?? []) {
        if (event.message === undefined || event.message.is_echo) continue;
        const conversation = channel.conversationRef(event);
        if (conversation === undefined || event.message.text === undefined) {
          continue;
        }
        const attachmentTypes = (event.message.attachments ?? []).map(
          (attachment) => attachment.type,
        );
        await dispatch(Assistant, {
          id: channel.instanceId(conversation),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            pageId: conversation.pageId,
            participant: conversation.participant,
          },
          message: {
            kind: 'signal',
            type: 'messenger.message',
            body: event.message.text,
            attributes: {
              messageId: event.message.mid,
              ...(event.message.quick_reply?.payload === undefined
                ? {}
                : { quickReplyPayload: event.message.quick_reply.payload }),
              ...(attachmentTypes.length === 0
                ? {}
                : { attachmentTypes: attachmentTypes.join(',') }),
            },
          },
        });
      }
    }
  },
});

export function postMessage(ref: MessengerConversationRef) {
  return defineTool({
    name: 'post_messenger_message',
    description: 'Post to the Messenger conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      const result = await client.messages.sendText({
        to: ref.participant,
        text,
      });
      return {
        ...(result.messageId === undefined ? {} : { messageId: result.messageId }),
      };
    },
  });
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/messenger.ts';

const app = new Hono();
app.route('/channels/messenger', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Paths:` comment in this guide assumes the
conventional `/channels/messenger` mount; a different mount path shifts every
provider URL accordingly.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/messenger.ts';

const initialDataSchema = v.object({
	pageId: v.string(),
	participant: v.variant('type', [
		v.object({ type: v.literal('page-scoped-id'), id: v.string() }),
		v.object({ type: v.literal('user-ref'), id: v.string() }),
	]),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Messenger channel dispatch.');
	useTool(postMessage(data));
	return 'Reply concisely in the bound Facebook Messenger conversation.';
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

## Configure Meta

Set:

```txt
MESSENGER_APP_SECRET=...
MESSENGER_VERIFY_TOKEN=...
MESSENGER_PAGE_ID=...
MESSENGER_PAGE_ACCESS_TOKEN=...
```

In the Meta app dashboard, configure this callback URL — the channel's mount
path in `app.ts` plus the route suffix, with the conventional
`app.route('/channels/messenger', ...)` mount:

```txt
https://example.com/channels/messenger/webhook
```

Use the exact `MESSENGER_VERIFY_TOKEN` value and subscribe the Page to the
fields the application handles. A useful starting set is `messages`,
`message_echoes`, `message_edits`, `messaging_postbacks`,
`message_reactions`, `message_deliveries`, `message_reads`,
`messaging_optins`, and `messaging_referrals`.

The app secret validates POST bodies. The Page access token is a separate
outbound credential. Never expose either secret to the model.

## Handle verified deliveries

Meta may batch several Page entries and events in one signed POST. The handler
runs once with the provider-native `payload`; iterate `payload.entry[]` and the
native `messaging`, `standby`, and `changes` arrays in Meta's delivered order.
The event family is discriminated by which property is present
(`event.message`, `event.postback`, `event.reaction`, `event.delivery`,
`event.read`, `event.optin`, `event.referral`, `event.message_edit`), exactly
as Meta documents. Field names stay snake_case (`mid`, `quick_reply.payload`,
`is_echo`); unmodeled families and fields are forwarded intact. One failure
causes the complete HTTP delivery to be retried, so claim message ids or other
stable event identities before dispatch when duplicate admission is
unacceptable.

`standby` events arrive while another app owns the conversation, and bot/echo
filtering (`message.is_echo`) is application policy — the channel forwards all
verified deliveries.

`channel.conversationRef(event)` derives the counterpart participant for a
native messaging event. Page-scoped ids and `user_ref` values are distinct
canonical participant types. Bind the derived conversation to a tool in trusted
code; do not let the model choose a recipient id.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the conversation's `pageId` and `participant` — the agent
reads them with `useInitialData()` instead of parsing the instance id. The
webhook carries no profile name, so there is no further context to fold in.
Per-message facts stay on the signal's `attributes`.

Opt-in events may contain a `notification_messages_token`. Treat it as a
short-lived provider capability. Keep tokens and full native payloads out of
the dispatched message, model context, logs, and durable session history.

Returning nothing produces `EVENT_RECEIVED` with status `200`. Return an
ordinary Hono or Fetch `Response` for explicit status, headers, or body. Meta
retries the delivery if it is not acknowledged promptly, so complete only
admission work inside the handler and move long-running behavior behind durable
dispatch or application queues. A handler that blocks does not buy more time;
rely on prompt admission plus idempotency rather than an in-handler deadline.

## Respect outbound policy

Messenger conversations are initiated by the person. Ordinary replies use the
24-hour standard messaging window. Message tags, marketing messages, one-time
notifications, private replies, rich templates, attachments, reactions,
typing, and read state have separate Meta policy and permission requirements.
Implement only the operations the application needs through the project-owned
client.

Messenger does not expose historical webhook notifications. Do not build a
process-local cache and describe it as provider history.

## Test without Meta

Create original synthetic JSON deliveries from current official schemas and
cover:

- GET verification, wrong tokens, and duplicate query parameters;
- exact-body HMAC-SHA256 verification in Node and workerd;
- changed Unicode bytes, missing and malformed signatures;
- fixed Page identity at entry and event boundaries;
- text, attachments, quick replies, replies, edits, postbacks, reactions,
  echoes, delivery receipts, reads, opt-ins, referrals, unknown fields,
  `standby`, and batches;
- both `entry.messaging` and documented `entry.changes` forms;
- body limits, malformed events, handler failures, `EVENT_RECEIVED`,
  JSON returns, and explicit `Response` control;
- canonical Page-scoped-id and `user_ref` instance id round trips;
- real outbound Fetch requests against local fake transports in Node and
  workerd;
- the project typecheck and `vite build` for the configured target.

Do not contact Meta or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
