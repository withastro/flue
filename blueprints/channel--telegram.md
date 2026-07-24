---
{
  "kind": "channel",
  "version": 1,
  "website": "https://core.telegram.org/bots/api"
}
---

# Add a Telegram Channel to Flue

You are an AI coding agent adding verified Telegram Bot API webhook ingress
with project-owned outbound Telegram access to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and which Telegram Update families the
application handles.

Install `@flue/telegram` and `grammy@^1.44.0`. Flue owns verified webhook
ingress. The project owns grammY's full `Api` client, update policy, durable
deduplication, and every outbound tool.

grammY's browser/Fetch export executes in Node and workerd with Flue's required
`nodejs_compat` configuration. Keep a workerd fake-transport test for every Bot
API operation the project relies on.

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/telegram.ts`. Adapt the imported agent,
dispatched message, handled update kinds, and tool:

The callback receives one verified provider-native Telegram `Update` (the
official `@grammyjs/types` shape, re-exported by `@flue/telegram` and by
grammY). At most one of its optional fields is present per update, so branch on
those fields directly. Derive the instance id from the native `Message`.

```ts
// flue-blueprint: channel/telegram@1
import {
  createTelegramChannel,
  type TelegramConversationRef,
} from '@flue/telegram';
import { defineTool, dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import type { Message } from 'grammy/types';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

export const client = new Api(process.env.TELEGRAM_BOT_TOKEN!);

export const channel = createTelegramChannel({
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,

  // Path: /channels/telegram/webhook
  async webhook({ update }) {
    const incoming =
      update.message ?? update.channel_post ?? update.business_message;
    if (incoming) {
      const conversation = conversationFromMessage(incoming);
      await dispatch(Assistant, {
        id: channel.instanceId(conversation),
        // Recorded once when this event creates the instance; ignored after.
        initialData: conversationData(conversation, incoming),
        message: {
          kind: 'signal',
          type: 'telegram.message',
          body: messageBody(incoming),
          attributes: { updateId: String(update.update_id) },
        },
      });
      return;
    }

    if (update.callback_query) {
      const query = update.callback_query;
      await client.answerCallbackQuery(query.id);
      if (!query.message) return;
      const conversation = conversationFromMessage(query.message);
      await dispatch(Assistant, {
        id: channel.instanceId(conversation),
        // Recorded once when this event creates the instance; ignored after.
        initialData: conversationData(conversation, query.message),
        message: {
          kind: 'signal',
          type: 'telegram.callback_query',
          body: query.data ?? '',
          attributes: {
            updateId: String(update.update_id),
            fromId: String(query.from.id),
            ...(query.from.username === undefined ? {} : { fromUsername: query.from.username }),
          },
        },
      });
      return;
    }
  },
});

// Message text, or a short placeholder describing a media-only message.
function messageBody(message: Message): string {
  if (message.text !== undefined) return message.text;
  if (message.caption !== undefined) return message.caption;
  if (message.photo) return '[photo message]';
  if (message.video) return '[video message]';
  if (message.voice) return '[voice message]';
  if (message.document) return '[document message]';
  if (message.sticker) return '[sticker message]';
  return '[non-text message]';
}

// Build the canonical destination identity from a native Telegram Message.
function conversationFromMessage(message: Message): TelegramConversationRef {
  const topic = {
    ...(message.message_thread_id === undefined
      ? {}
      : { messageThreadId: message.message_thread_id }),
    ...(message.direct_messages_topic?.topic_id === undefined
      ? {}
      : { directMessagesTopicId: message.direct_messages_topic.topic_id }),
  };
  return message.business_connection_id
    ? {
        type: 'business-chat',
        businessConnectionId: message.business_connection_id,
        chatId: message.chat.id,
        ...topic,
      }
    : { type: 'chat', chatId: message.chat.id, ...topic };
}

// Instance-creation data: the destination ref plus small instance-constant context.
function conversationData(conversation: TelegramConversationRef, message: Message) {
  return {
    type: conversation.type,
    chatId: conversation.chatId,
    ...(conversation.type === 'business-chat'
      ? { businessConnectionId: conversation.businessConnectionId }
      : {}),
    ...(conversation.messageThreadId === undefined
      ? {}
      : { messageThreadId: conversation.messageThreadId }),
    ...(conversation.directMessagesTopicId === undefined
      ? {}
      : { directMessagesTopicId: conversation.directMessagesTopicId }),
    ...(message.chat.title === undefined ? {} : { chatTitle: message.chat.title }),
  };
}

export function postMessage(ref: TelegramConversationRef) {
  return defineTool({
    name: 'post_telegram_message',
    description: 'Post a message to the Telegram conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      const message = await client.sendMessage(ref.chatId, text, {
        ...(ref.type === 'business-chat'
          ? { business_connection_id: ref.businessConnectionId }
          : {}),
        ...(ref.messageThreadId
          ? { message_thread_id: ref.messageThreadId }
          : {}),
        ...(ref.directMessagesTopicId
          ? { direct_messages_topic_id: ref.directMessagesTopicId }
          : {}),
      });
      return { messageId: message.message_id };
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
import { channel } from './channels/telegram.ts';

const app = new Hono();
app.route('/channels/telegram', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comment in this guide assumes the
conventional `/channels/telegram` mount; a different mount path shifts every
provider URL accordingly.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { postMessage } from '../channels/telegram.ts';

const chatData = v.object({
	type: v.literal('chat'),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const businessChatData = v.object({
	type: v.literal('business-chat'),
	businessConnectionId: v.string(),
	chatId: v.number(),
	messageThreadId: v.optional(v.number()),
	directMessagesTopicId: v.optional(v.number()),
	chatTitle: v.optional(v.string()),
});
const initialDataSchema = v.variant('type', [chatData, businessChatData]);

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Telegram channel dispatch.');
	useTool(postMessage(data));
	const chatTitle = data.chatTitle ? ` ("${data.chatTitle}")` : '';
	return `Reply concisely in the bound Telegram conversation${chatTitle}.`;
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

## Configure Telegram

Create a random `TELEGRAM_WEBHOOK_SECRET_TOKEN` containing only letters,
numbers, underscores, and hyphens. Do not reuse it across bots. Register the
route and the secret — the registered URL is the channel's mount path in
`app.ts` plus the route suffix, shown here with the conventional
`app.route('/channels/telegram', ...)` mount:

```ts
await client.setWebhook('https://example.com/channels/telegram/webhook', {
  secret_token: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
  allowed_updates: [
    'message',
    'edited_message',
    'channel_post',
    'edited_channel_post',
    'business_message',
    'edited_business_message',
    'guest_message',
    'callback_query',
    'message_reaction',
    'message_reaction_count',
  ],
});
```

Telegram sends the configured value in
`X-Telegram-Bot-Api-Secret-Token`. The package requires it before parsing.
Telegram does not sign request bodies or supply a signed timestamp.

Each webhook body contains exactly one Update. Telegram retries unsuccessful
requests. Returning nothing produces an empty `200`; a JSON-compatible value
becomes the response body and may contain a Bot API method call; return a
normal Hono or Fetch `Response` for explicit status control.

The package forwards `updateId` but does not persist deduplication state. Claim
the id in durable application storage before dispatch when duplicate admission
is unacceptable.

Webhook delivery and `getUpdates` polling are mutually exclusive. Do not add
polling lifecycle behavior to the Flue channel.

## Respect identity boundaries

Regular and business chats need different conversation types. When you derive an
instance id from a native `Message`, preserve `business_connection_id`,
`message_thread_id`, and `direct_messages_topic.topic_id` so replies reach the
same destination.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the structured conversation facts — the agent reads them
with `useInitialData()` instead of parsing the instance id — plus small
instance-constant context like the chat's title. Per-message facts stay on the
signal's `attributes`.

Do not build a durable instance id for `update.guest_message`. Its
`message.guest_query_id` is a short-lived capability for `answerGuestQuery`, not
identity. Inline callback queries (`update.callback_query` without a
`message`) likewise supply no accessible chat. Do not place either value in
model context, logs, durable session data, or persistent agent ids.

## Test without Telegram

Create original synthetic Update objects from the current Bot API schema and
cover:

- correct, missing, and changed webhook secret headers;
- messages, edits, channel posts, business messages, guest messages, callback
  queries, and reactions, asserting the native `Update` is forwarded unchanged;
- a future or otherwise unmodeled verified update variant;
- malformed Update envelopes (no `update_id`, non-object body) and body limits;
- regular, business, thread, and direct-topic instance ids;
- empty, JSON, Hono, thrown, and invalid handler responses;
- real grammY `Api` calls against an injected fake Fetch transport in workerd;
- the project typecheck and `vite build` for the configured target.

Do not contact Telegram or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
