---
title: Telegram Channel API
description: Reference for verified Telegram Bot API ingress from @flue/telegram.
---

Import from `@flue/telegram`.

## `createTelegramChannel()`

```ts
function createTelegramChannel<E extends Env = Env>(
  options: TelegramChannelOptions<E>,
): TelegramChannel<E>;
```

Creates one stateless `POST /webhook` route.

## `TelegramChannelOptions`

```ts
interface TelegramChannelOptions<E extends Env = Env> {
  secretToken: string;
  bodyLimit?: number;
  webhook(input: TelegramWebhookHandlerInput<E>): TelegramHandlerResult;
}
```

| Field         | Description                                                                  |
| ------------- | ---------------------------------------------------------------------------- |
| `secretToken` | The 1-256 character `secret_token` configured through Telegram `setWebhook`. |
| `bodyLimit`   | Maximum request body. Default: 1 MiB.                                        |
| `webhook`     | Callback for one verified provider-native Telegram `Update`.                 |

`secretToken` accepts only Telegram's documented `A-Z`, `a-z`, `0-9`, `_`, and
`-` characters. It is required by Flue even though Telegram makes the setting
optional.

```ts
interface TelegramWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  update: Update;
}

type TelegramHandlerResult =
  | undefined
  | JsonValue
  | Response
  | Promise<undefined | JsonValue | Response>;
```

The callback receives the Hono `Context` as `c` and the verified update as
`update`. Returning nothing produces an empty `200`. A JSON-compatible value
becomes the webhook response body and may use Telegram's webhook-reply method
format. An ordinary Hono or Fetch `Response` passes through.

## `TelegramChannel`

```ts
interface TelegramChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: TelegramConversationRef): string;
  parseConversationKey(id: string): TelegramConversationRef;
}
```

A file named `channels/telegram.ts` serves
`POST /channels/telegram/webhook` relative to the `flue()` mount.

The channel does not persist or deduplicate `update_id` values. Conversation
keys are canonical identifiers, not authorization capabilities.

## Updates

```ts
import type { Update } from '@flue/telegram';
```

The verified `update` is the provider-native Telegram Bot API `Update`,
re-exported from the official, spec-generated
[`@grammyjs/types`](https://github.com/grammyjs/types) package — the same shape
grammY itself uses. `@flue/telegram` does not define a parallel normalized
model: updates are forwarded with Telegram's own field names, nesting, and
discriminants.

At most one of an `Update`'s optional fields is present per delivery, so branch
on those fields directly rather than on a `type` discriminant:

```ts
async webhook({ update }) {
  const incoming =
    update.message ?? update.channel_post ?? update.business_message;
  if (incoming) {
    // incoming is a native Message
  } else if (update.callback_query) {
    // update.callback_query is a native CallbackQuery
  }
}
```

`update.update_id` is Telegram's native ordering and duplicate-detection key.
The channel validates only the envelope (a JSON object with a non-negative
`update_id`); the full update is not exhaustively schema-checked. Derive
conversation identity from the native `Message` (see below).

## Identity

```ts
type TelegramConversationRef =
  | {
      type: 'chat';
      chatId: number;
      messageThreadId?: number;
      directMessagesTopicId?: number;
    }
  | {
      type: 'business-chat';
      businessConnectionId: string;
      chatId: number;
      messageThreadId?: number;
      directMessagesTopicId?: number;
    };
```

`conversationKey()` serializes a `TelegramConversationRef` you derive from a
native `Message`: read `message.chat.id`, `message.business_connection_id`,
`message.message_thread_id`, and `message.direct_messages_topic?.topic_id`.
`parseConversationKey()` is the inverse and accepts only canonical keys.

Regular and business chats remain separate because Telegram permits their chat
identifiers to overlap; supply `businessConnectionId` for the `business-chat`
type. Forum threads and direct-message topics are distinct destinations and
cannot both be set.

Some native updates carry no durable chat destination. A guest message's
`guest_query_id` is a short-lived `answerGuestQuery` capability, not identity,
and an inline `callback_query` without a `message` exposes no accessible chat.
Do not derive a conversation key from either, and do not place such capability
values in model context, logs, durable session data, or conversation keys.

## Errors

- `InvalidTelegramConversationKeyError`
- `InvalidTelegramInputError`, with structured `field`

See [Telegram setup](/docs/ecosystem/channels/telegram/) for webhook and grammY
composition.
