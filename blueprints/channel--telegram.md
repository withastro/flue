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
`<root>/`. Inspect existing agents, environment types, secret conventions, and
which Telegram Update families the application handles.

Install `@flue/telegram` and `grammy@^1.44.0`. Flue owns verified webhook
ingress. The project owns grammY's full `Api` client, update policy, durable
deduplication, and every outbound tool.

grammY's browser/Fetch export executes in Node and workerd with Flue's required
`nodejs_compat` configuration. Keep a workerd fake-transport test for every Bot
API operation the project relies on.

## Create the channel

Create `<source-dir>/channels/telegram.ts`. Adapt the imported agent,
dispatched input, handled update kinds, and tool:

The callback receives one verified provider-native Telegram `Update` (the
official `@grammyjs/types` shape, re-exported by `@flue/telegram` and by
grammY). At most one of its optional fields is present per update, so branch on
those fields directly. Derive the conversation key from the native `Message`.

```ts
// flue-blueprint: channel/telegram@1
import {
  createTelegramChannel,
  type TelegramConversationRef,
} from '@flue/telegram';
import { defineTool, dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import type { Message } from 'grammy/types';
import assistant from '../agents/assistant.ts';

export const client = new Api(process.env.TELEGRAM_BOT_TOKEN!);

export const channel = createTelegramChannel({
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,

  // Path: /channels/telegram/webhook
  async webhook({ update }) {
    const incoming =
      update.message ?? update.channel_post ?? update.business_message;
    if (incoming) {
      await dispatch(assistant, {
        id: channel.conversationKey(conversationFromMessage(incoming)),
        input: {
          type: 'telegram.message',
          updateId: update.update_id,
          message: incoming,
        },
      });
      return;
    }

    if (update.callback_query) {
      const query = update.callback_query;
      await client.answerCallbackQuery(query.id);
      if (!query.message) return;
      await dispatch(assistant, {
        id: channel.conversationKey(conversationFromMessage(query.message)),
        input: {
          type: 'telegram.callback_query',
          updateId: update.update_id,
          data: query.data,
          from: query.from,
        },
      });
      return;
    }
  },
});

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

export function postMessage(ref: TelegramConversationRef) {
  return defineTool({
    name: 'post_telegram_message',
    description: 'Post a message to the Telegram conversation bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
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
      return JSON.stringify({ messageId: message.message_id });
    },
  });
}
```

## Wire the agent

```ts
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/telegram.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Configure Telegram

Create a random `TELEGRAM_WEBHOOK_SECRET_TOKEN` containing only letters,
numbers, underscores, and hyphens. Do not reuse it across bots. Register the
route and the secret:

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

Regular and business chats need different conversation types. When you derive a
conversation key from a native `Message`, preserve `business_connection_id`,
`message_thread_id`, and `direct_messages_topic.topic_id` so replies reach the
same destination.

Do not build a durable conversation key for `update.guest_message`. Its
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
- regular, business, thread, and direct-topic conversation keys;
- empty, JSON, Hono, thrown, and invalid handler responses;
- real grammY `Api` calls against an injected fake Fetch transport in workerd;
- Node and Cloudflare project builds.

Do not contact Telegram or copy third-party fixtures.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
