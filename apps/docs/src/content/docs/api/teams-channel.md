---
title: Microsoft Teams Channel API
description: Reference for authenticated Microsoft Teams Bot Connector ingress from @flue/teams.
lastReviewedAt: 2026-06-13
---

Import from `@flue/teams`.

## `createTeamsChannel()`

```ts
function createTeamsChannel<E extends Env = Env>(options: TeamsChannelOptions<E>): TeamsChannel<E>;
```

Creates one stateless, fixed-application, fixed-tenant Teams activity channel.
The callback runs only after Bot Connector token, channel, service URL, and
host-tenant verification.

## `TeamsChannelOptions`

```ts
interface TeamsChannelOptions<E extends Env = Env> {
  appId: string;
  tenantId: string;
  openIdMetadataUrl?: string;
  tokenIssuer?: string;
  fetch?: typeof globalThis.fetch;
  bodyLimit?: number;
  handlerTimeoutMs?: number;
  activities(input: { c: Context<E>; activity: TeamsActivity }): TeamsHandlerResult;
}
```

| Field               | Description                                                   |
| ------------------- | ------------------------------------------------------------- |
| `appId`             | Expected Bot Connector JWT audience.                          |
| `tenantId`          | Expected tenant in the authenticated activity.                |
| `openIdMetadataUrl` | OpenID metadata URL. Defaults to Microsoft's public cloud.    |
| `tokenIssuer`       | Expected issuer. Defaults to `https://api.botframework.com`.  |
| `fetch`             | Fetch used for OpenID metadata and JWKS discovery.            |
| `bodyLimit`         | Maximum request body. Default: 1 MiB.                         |
| `handlerTimeoutMs`  | Handler deadline. Default and maximum: 4500 milliseconds.     |
| `activities`        | Receives every authenticated and structurally valid activity. |

```ts
type TeamsHandlerResult = void | JsonValue | Response | Promise<void | JsonValue | Response>;
```

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. An ordinary Hono or Fetch `Response` passes through unchanged.

## `TeamsChannel`

```ts
interface TeamsChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: TeamsConversationRef): string;
  parseConversationKey(id: string): TeamsConversationRef;
}
```

`routes` contains one `POST /activities` declaration. A file named
`channels/teams.ts` is served at `/channels/teams/activities` relative to the
`flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.

## Activities

```ts
type TeamsActivity =
  | TeamsMessageActivity
  | TeamsConversationUpdateActivity
  | TeamsInvokeActivity
  | TeamsMessageReactionActivity
  | TeamsUnknownActivity;
```

Known variants use `type: 'message'`, `type: 'conversation_update'`,
`type: 'invoke'`, or `type: 'message_reaction'`. Each known activity includes:

```ts
interface TeamsActivityEnvelope<TType extends string, TPayload> {
  type: TType;
  activityId?: string;
  timestamp?: string;
  tenantId: string;
  serviceUrl: string;
  destination: TeamsConversationRef;
  sender?: TeamsAccountRef;
  bot: TeamsAccountRef;
  payload: TPayload;
  raw: unknown;
}
```

Message payloads expose optional text and locale, attachments, normalized
mentions, and optional provider value data. Conversation updates expose added
and removed members. Invoke activities expose the provider name and value.
Reaction activities expose added and removed reaction names.

Unsupported authenticated activity types use `type: 'unknown'` and retain the
provider `activityType`.

## Identity

```ts
interface TeamsConversationRef {
  tenantId: string;
  serviceUrl: string;
  conversationId: string;
  scope: 'personal' | 'groupChat' | 'channel' | 'unknown';
  botId: string;
  threadId?: string;
  teamId?: string;
  channelId?: string;
}
```

For channel activities, `threadId` is the provider `replyToId` or the current
activity id for a root message. The verified `serviceUrl` is retained so
stateless applications can address the correct Bot Connector endpoint.

```ts
interface TeamsAccountRef {
  id: string;
  name?: string;
  aadObjectId?: string;
}

interface TeamsMention {
  mentioned: TeamsAccountRef;
  text?: string;
}
```

## Verification

The package retrieves the configured OpenID metadata and endorsed JWKS keys,
caches them with bounded response cache metadata, and refreshes once when a
token references an unknown key id.

Requests fail before the callback when the bearer token, signature, issuer,
audience, expiration, `msteams` endorsement, exact service URL, channel id, or
tenant identity is invalid. Discovery failures return `503`.

## Errors

- `InvalidTeamsConversationKeyError`
- `InvalidTeamsInputError`, with structured `field`

See [Microsoft Teams setup](/docs/guide/channels/teams/) for the project-owned
Fetch client and application tool composition.
