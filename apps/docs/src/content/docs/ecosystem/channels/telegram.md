---
title: Telegram
description: Receive verified Telegram Bot API Updates with a project-owned grammY client.
package:
  name: '@flue/telegram'
  href: https://www.npmjs.com/package/@flue/telegram
lastReviewedAt: 2026-07-21
---

## Quickstart

Add verified Telegram Bot API webhook ingress with project-owned outbound Telegram access to an existing Flue project with the [Telegram](https://core.telegram.org/bots/api) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel telegram
```

## Overview

The blueprint installs `@flue/telegram` and grammY, creates a source-root
`channels/telegram.ts` module with named `channel` and project-owned `client`
exports, and modifies the selected agent to bind the generated message tool.

```ts title="src/channels/telegram.ts (abridged)"
import { createTelegramChannel } from '@flue/telegram';
import { dispatch } from '@flue/runtime';
import { Api } from 'grammy';
import { Assistant } from '../agents/assistant.ts';

export const client = new Api(process.env.TELEGRAM_BOT_TOKEN!);

export const channel = createTelegramChannel({
  secretToken: process.env.TELEGRAM_WEBHOOK_SECRET_TOKEN!,
  async webhook({ update }) {
    const incoming = update.message ?? update.channel_post ?? update.business_message;
    if (!incoming) return;
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
  },
});
```

The abridged example omits the generated `conversationFromMessage`,
`conversationData`, and `messageBody` helpers, callback-query branch, and
message tool. Once configured, an incoming message
continues the agent instance for its chat, business chat, or topic, and the
bound grammY tool replies to that same destination. grammY's Fetch export runs
on Node and Cloudflare Workers with Flue's `nodejs_compat` setting.

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the module's named `channel` export:

```ts title="src/app.ts"
import { channel as telegram } from './channels/telegram.ts';

app.route('/channels/telegram', telegram.route());
```

`channel.route()` is a pure router factory serving the channel's declared routes relative to the mount path. The webhook paths in this guide assume the conventional `/channels/telegram` mount; a different mount path shifts them accordingly. The dispatch-target agent module carries the `'use agent'` directive — the directive registers it, so a dispatch-only agent needs no HTTP mount of its own.

## Configure

| Variable                        | Purpose                                              |
| ------------------------------- | ---------------------------------------------------- |
| `TELEGRAM_WEBHOOK_SECRET_TOKEN` | **Required** — Verifies inbound webhook requests.    |
| `TELEGRAM_BOT_TOKEN`            | **Required** — Authenticates outbound Bot API calls. |

It installs `@flue/telegram` for verified ingress and grammY for project-owned
Bot API access. grammY publishes a browser/Fetch build that runs in both Node
and workerd with Flue's required `nodejs_compat` configuration.

Set the webhook URL to:

```txt
https://example.com/channels/telegram/webhook
```

Generate an independent random webhook secret using only letters, numbers,
underscores, and hyphens. Configure it with the full route:

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

Telegram sends the secret in `X-Telegram-Bot-Api-Secret-Token`.
`@flue/telegram` rejects a missing or changed value before parsing the Update.
Telegram does not sign the body or include a signed timestamp, so do not reuse
one secret across bots.

Webhook delivery and `getUpdates` polling are mutually exclusive. Polling is
outside the HTTP channel package.

## Channel module

```ts title="src/channels/telegram.ts"
import { createTelegramChannel, type TelegramConversationRef } from '@flue/telegram';
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
    const incoming = update.message ?? update.channel_post ?? update.business_message;
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
    description: 'Post to the Telegram conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data: { text } }) {
      const message = await client.sendMessage(ref.chatId, text, {
        ...(ref.type === 'business-chat'
          ? { business_connection_id: ref.businessConnectionId }
          : {}),
        ...(ref.messageThreadId ? { message_thread_id: ref.messageThreadId } : {}),
        ...(ref.directMessagesTopicId
          ? { direct_messages_topic_id: ref.directMessagesTopicId }
          : {}),
      });
      return { messageId: message.message_id };
    },
  });
}
```

## Bind the tool

`initialData` is the instance's creation data: recorded once when the event creates the
instance and ignored afterward, so the channel passes it on every dispatch. Bind
the tool from the agent with `useInitialData()` instead of parsing the instance
id:

```ts title="src/agents/assistant.ts"
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
const initialData = v.variant('type', [chatData, businessChatData]);

export function Assistant() {
  useModel('anthropic/claude-haiku-4-5');
  const data = useInitialData<v.InferOutput<typeof initialData>>();
  if (!data) throw new Error('This agent is created by the Telegram channel dispatch.');
  useTool(postMessage(data));
  const chatTitle = data.chatTitle ? ` ("${data.chatTitle}")` : '';
  return `Reply concisely in the bound Telegram conversation${chatTitle}.`;
}

Assistant.initialData = initialData;
```

Trusted code binds the chat, business connection, and optional topic. The model
selects only message text.

## Verified inbound

Flue owns one job on the inbound side: it verifies the
`X-Telegram-Bot-Api-Secret-Token` header, enforces the body limit, parses the
JSON, and forwards a single provider-native Bot API `Update` to your callback.
There is no parallel normalized model — the update keeps Telegram's own field
names, nesting, and discriminants. The authoritative type is the
spec-generated [`@grammyjs/types`](https://github.com/grammyjs/types) `Update`,
which `@flue/telegram` re-exports (the same type grammY uses).

Because at most one of an `Update`'s optional fields is present per delivery,
branch on those fields instead of a discriminant. The example above reads
`update.message ?? update.channel_post ?? update.business_message` for incoming
messages and `update.callback_query` for callbacks; widen the branches to the
update families your bot enabled in `allowed_updates`. Each native `Message`
carries its own conversation identity, which `conversationFromMessage` reads to
build the `TelegramConversationRef`.

Each delivery contains one Update and invokes the callback once.
`update.update_id` is Telegram's ordering and duplicate-detection key. The
package does not persist it; claim it in application storage before dispatch
when duplicate admission is unacceptable.

Telegram retries unsuccessful webhook requests. Returning nothing produces an
empty `200`. Return JSON to use Telegram's webhook-reply method format, or use
the Hono context for explicit status control.

## Conversation identity

`conversationFromMessage` derives a canonical instance id from the native
`Message`: regular chats, business chats, forum threads, and channel
direct-message topics produce distinct ids. Business identity includes
`businessConnectionId` because Telegram warns that business chat ids can match
ordinary bot chat ids, and a thread id (`message_thread_id`) and direct-message
topic id (`direct_messages_topic.topic_id`) are mutually exclusive.

Some native updates have no durable chat destination, so do not build an
instance id from them. A guest message's `guest_query_id` authorizes one
short-lived `answerGuestQuery` response and must not enter model context, logs,
durable session data, or agent identity. An inline `callback_query` without a
`message` likewise supplies no accessible chat.

See the [`@flue/telegram` README](https://github.com/withastro/flue/tree/main/packages/telegram#readme).
