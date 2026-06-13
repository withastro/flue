---
title: Discord Channel API
description: Reference for @flue/discord.
lastReviewedAt: 2026-06-12
---

Import the Discord channel API from `@flue/discord`.

## `createDiscordChannel()`

```ts
function createDiscordChannel(options: DiscordChannelOptions): DiscordChannel;
```

Creates one fixed-application HTTP interactions integration.

### `DiscordChannelOptions`

| Field              | Type                      | Default                               |
| ------------------ | ------------------------- | ------------------------------------- |
| `publicKey`        | `string`                  | Required 64-character hexadecimal key |
| `applicationId`    | `string`                  | Required                              |
| `botToken`         | `string`                  | Required                              |
| `fetch`            | `typeof globalThis.fetch` | `globalThis.fetch`                    |
| `requestTimeoutMs` | `number`                  | `10000`                               |

## `DiscordChannel`

### `routes.interactions()`

```ts
interactions(options?: DiscordInteractionRouteOptions): DiscordRouteHandler;
```

Returns an unbound-safe Fetch handler. `bodyLimit` defaults to 1 MiB.
`handlerTimeoutMs` defaults to and may not exceed 2500. Signed PING requests are
handled internally.

### Handlers

```ts
onCommand(
  name: string,
  handler: DiscordInteractionHandler<
    DiscordInteractionEnvelope<DiscordCommandData>,
    DiscordCommandResponse
  >,
): () => void;

onComponent(
  customId: string,
  handler: DiscordInteractionHandler<
    DiscordInteractionEnvelope<DiscordComponentData>,
    DiscordComponentResponse
  >,
): () => void;

onModal(
  customId: string,
  handler: DiscordInteractionHandler<
    DiscordInteractionEnvelope<DiscordModalData>,
    DiscordModalResponse
  >,
): () => void;
```

Each command or custom id has one response owner.

Command handlers accept chat-input commands. Component handlers accept buttons.
Modal handlers receive normalized `fields` while retaining provider-native
components.

Supported immediate responses:

```ts
type DiscordCommandResponse =
  | { type: 'message'; message: DiscordMessage; ephemeral?: boolean }
  | {
      type: 'modal';
      customId: string;
      title: string;
      components: readonly DiscordComponent[];
    };

type DiscordComponentResponse =
  | { type: 'message'; message: DiscordMessage; ephemeral?: boolean }
  | { type: 'update_message'; message: DiscordMessage }
  | {
      type: 'modal';
      customId: string;
      title: string;
      components: readonly DiscordComponent[];
    };

type DiscordModalResponse =
  | { type: 'message'; message: DiscordMessage; ephemeral?: boolean }
  | { type: 'update_message'; message: DiscordMessage };
```

Immediate message responses disable parsed mentions by default.

### Components

`DiscordMessage.components` supports action rows containing non-link buttons
with `customId`, `label`, `style`, and optional `disabled`.

Modal responses support Label components containing text inputs with
`customId`, `style`, optional placeholder/required state, and optional minimum
or maximum length.

```ts
interface DiscordMessage {
  content: string;
  components?: readonly DiscordComponent[];
  allowedMentions?: {
    parse?: Array<'users' | 'roles' | 'everyone'>;
    users?: string[];
    roles?: string[];
  };
}
```

### `client`

```ts
postMessage(
  ref: DiscordDestinationRef,
  message: DiscordMessage,
  signal?: AbortSignal,
): Promise<void>;
```

Posts an ordinary message through the fixed Discord API v10 origin. Writes are
not retried automatically. Parsed mentions default to disabled unless
`allowedMentions` explicitly enables them.

### `tools.postMessage()`

```ts
postMessage(
  ref: DiscordDestinationRef,
  options?: DiscordMessageToolOptions,
): ToolDefinition;
```

Snapshots the destination and mention policy. `allowMentions` defaults to no
mention classes.

### `DiscordDestinationRef`

```ts
type DiscordDestinationRef =
  | {
      type: 'guild';
      guildId: string;
      channelId: string;
      channelKind: 'channel' | 'thread';
    }
  | {
      type: 'dm';
      channelId: string;
    };
```

### Conversation keys

```ts
conversationKey(ref: DiscordDestinationRef): string;
parseConversationKey(id: string): DiscordDestinationRef;
```

Supported refs are guild channels, guild threads, and bot DMs. Keys are
canonical identifiers, not authorization capabilities.

## Sensitive interaction fields

`DiscordInteractionEnvelope.token` and `raw` are handler-level provider
capabilities. Do not place them in dispatch input, model context, logs, or
durable session history.

## Errors

| Error                                | Structured fields                                                                                                    |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `DuplicateDiscordHandlerError`       | `kind`, `key`                                                                                                        |
| `InvalidDiscordConversationKeyError` | —                                                                                                                    |
| `InvalidDiscordInputError`           | `field`                                                                                                              |
| `DiscordApiError`                    | `status`, `code`, `requestId`, `responseMessage`, `retryAfterSeconds`, `global`, `rateLimitScope`, `rateLimitBucket` |
| `DiscordRateLimitError`              | Same as `DiscordApiError`                                                                                            |
| `DiscordTimeoutError`                | `timeoutMs`                                                                                                          |

See [Discord setup](/docs/guide/channels/discord/) for an end-to-end example.
