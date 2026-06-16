---
title: Linear Channel API
description: Reference for verified Linear ingress from @flue/linear.
---

Import from `@flue/linear`.

## `createLinearChannel()`

```ts
function createLinearChannel<E extends Env = Env>(
  options: LinearChannelOptions<E>,
): LinearChannel<E>;
```

Creates one stateless `POST /webhook` route.

## `LinearChannelOptions`

```ts
interface LinearChannelOptions<E extends Env = Env> {
  webhookSecret: string;
  organizationId?: string;
  webhookId?: string;
  bodyLimit?: number;
  webhook(input: LinearWebhookHandlerInput<E>): LinearHandlerResult;
}
```

| Field            | Description                                                        |
| ---------------- | ------------------------------------------------------------------ |
| `webhookSecret`  | Secret used to verify exact request bytes with HMAC-SHA256.        |
| `organizationId` | Optional signed organization constraint. Mismatches receive `403`. |
| `webhookId`      | Optional signed webhook constraint. Mismatches receive `403`.      |
| `bodyLimit`      | Maximum request body. Default: 1 MiB.                              |
| `webhook`        | Callback for every verified delivery.                              |

```ts
type LinearHandlerResult = void | JsonValue | Response | Promise<void | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. An ordinary Hono or Fetch `Response` passes through.

## `LinearChannel`

```ts
interface LinearChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: LinearConversationRef): string;
  parseConversationKey(id: string): LinearConversationRef;
}
```

A file named `channels/linear.ts` serves
`POST /channels/linear/webhook` relative to the `flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.

## `LinearWebhookHandlerInput`

```ts
interface LinearWebhookHandlerInput<E extends Env = Env> {
  c: Context<E>;
  payload: LinearWebhookPayload;
  deliveryId: string;
}
```

`payload` is the verified provider-native body. `deliveryId` comes from the
required `Linear-Delivery` header. The channel rejects a missing or malformed
UUID-v4 value before invoking the callback. Linear signs the body, not that
transport header, and the channel does not deduplicate.

## `LinearWebhookPayload`

```ts
export type { LinearWebhookPayload } from '@linear/sdk/webhooks';
```

The channel re-exports Linear's official webhook union from
`@linear/sdk/webhooks` and forwards the verified body unmodified, with Linear's
own field names, nesting, `type`, `action`, and `data`. Entity deliveries carry
`type` (`'Comment'`, `'Issue'`, `'Project'`, …), `action` (`'create'`,
`'update'`, `'remove'`), and `data`; agent-session deliveries carry
`type: 'AgentSessionEvent'`, `action` (`'created'`, `'prompted'`),
`agentSession`, and `agentActivity`. The channel does not reshape payloads and
forwards verified deliveries the union does not model.

The official union includes a catch-all
`EntityWebhookPayloadWithUnknownEntityData` member whose `type` stays widened to
`string`, so a literal check such as `payload.type === 'Comment'` does **not**
narrow the union on its own. Narrow application-side with a small type guard that
pairs the `type` literal with a discriminating nested field, returning the
official member type:

```ts
import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithCommentData,
} from '@linear/sdk/webhooks';

function isCommentEvent(
  payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithCommentData {
  return payload.type === 'Comment' && 'body' in payload.data;
}

function isAgentSessionEvent(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === 'AgentSessionEvent' && 'agentSession' in payload;
}
```

The application derives conversation keys from native fields — for example
`payload.organizationId` with `payload.data.issueId`/`parentId` or
`payload.agentSession.id` — and passes them to `conversationKey(...)`.

## Identity

```ts
type LinearConversationRef =
  | {
      type: 'issue';
      organizationId: string;
      issueId: string;
      threadCommentId?: string;
    }
  | {
      type: 'agent-session';
      organizationId: string;
      agentSessionId: string;
    };
```

Top-level comments omit `threadCommentId` and use the issue conversation.
Replies use their root comment id. Agent-session conversations use the session
id.

## Errors

- `InvalidLinearConversationKeyError`
- `InvalidLinearInputError`, with structured `field`

See [Linear setup](/docs/ecosystem/channels/linear/) for webhook and official SDK
composition.
