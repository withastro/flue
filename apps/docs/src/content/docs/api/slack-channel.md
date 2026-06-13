---
title: Slack Channel API
description: Reference for @flue/slack.
lastReviewedAt: 2026-06-12
---

Import the Slack channel API from `@flue/slack`.

## `createSlackChannel()`

```ts
function createSlackChannel(options: SlackChannelOptions): SlackChannel;
```

Creates one fixed-application, fixed-workspace integration.

### `SlackChannelOptions`

| Field              | Type                      | Default            |
| ------------------ | ------------------------- | ------------------ |
| `signingSecret`    | `string`                  | Required           |
| `botToken`         | `string`                  | Required           |
| `appId`            | `string`                  | Required           |
| `teamId`           | `string`                  | Required           |
| `fetch`            | `typeof globalThis.fetch` | `globalThis.fetch` |
| `requestTimeoutMs` | `number`                  | `10000`            |

## `SlackChannel`

### Routes

```ts
events(options?: SlackRouteOptions): SlackRouteHandler;
interactions(options?: SlackRouteOptions): SlackRouteHandler;
```

Both factories return unbound-safe Fetch handlers. `bodyLimit` defaults to
1 MiB. `handlerTimeoutMs` defaults to and may not exceed 2500.

### Event handlers

```ts
on<TKey extends SlackEventName>(
  type: TKey,
  handler: SlackNotificationHandler<SlackEvents[TKey]>,
): () => void;
```

Supported keys are `app_mention` and `message`. Each key has one handler owner.

### Interaction handlers

```ts
onAction(
  actionId: string,
  handler: SlackInteractionHandler<SlackActionEnvelope, SlackActionResponse>,
): () => void;

onView(
  callbackId: string,
  handler: SlackInteractionHandler<SlackViewSubmissionEnvelope, SlackViewResponse>,
): () => void;
```

Action handlers return `{ type: 'ack' }`. View handlers return acknowledgement
or field validation errors.

```ts
type SlackActionResponse = { type: 'ack' };

type SlackViewResponse =
  | { type: 'ack' }
  | {
      type: 'validation_errors';
      errors: Record<string, string>;
    };
```

`SlackActionEnvelope` includes normalized identity, destination, `actionId`,
optional signed `value`, the provider-native action as `payload`, and the full
parsed interaction as `raw`. `raw` may contain a signed `response_url`
capability; keep it out of dispatch input, model context, logs, and durable
session history.

### `client`

```ts
interface SlackClient {
  postMessage(ref: SlackThreadRef, message: SlackMessage, signal?: AbortSignal): Promise<void>;
  addReaction(ref: SlackThreadRef, name: string, signal?: AbortSignal): Promise<void>;
}
```

`postMessage()` accepts text and optional provider-native Block Kit `blocks`.
`addReaction()` targets `ref.threadTs`.

### `tools`

```ts
replyInThread(ref: SlackThreadRef): ToolDefinition;
addReaction(ref: SlackThreadRef): ToolDefinition;
```

Factories snapshot the configured-workspace destination. Model arguments do not
contain credentials or destination ids.

### `SlackThreadRef`

```ts
interface SlackThreadRef {
  teamId: string;
  channelId: string;
  threadTs: string;
}
```

### Conversation keys

```ts
conversationKey(ref: SlackThreadRef): string;
parseConversationKey(id: string): SlackThreadRef;
```

Keys are canonical identifiers, not authorization capabilities.

## Errors

| Error                              | Structured fields                                                     |
| ---------------------------------- | --------------------------------------------------------------------- |
| `DuplicateSlackHandlerError`       | `kind`, `key`                                                         |
| `InvalidSlackConversationKeyError` | —                                                                     |
| `InvalidSlackInputError`           | `field`                                                               |
| `SlackApiError`                    | `status`, `code`, `requestId`, `responseMessage`, `retryAfterSeconds` |
| `SlackRateLimitError`              | Same as `SlackApiError`                                               |
| `SlackTimeoutError`                | `timeoutMs`                                                           |

See [Slack setup](/docs/guide/channels/slack/) for an end-to-end example.
