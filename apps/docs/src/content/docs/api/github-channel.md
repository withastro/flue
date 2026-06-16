---
title: GitHub Channel API
description: Reference for verified GitHub webhook ingress from @flue/github.
---

Import from `@flue/github`.

## `createGitHubChannel()`

```ts
function createGitHubChannel<E extends Env = Env>(
  options: GitHubChannelOptions<E>,
): GitHubChannel<E>;
```

Creates one stateless GitHub webhook channel. The callback is stored during
construction and runs only for a verified non-ping delivery.

## `GitHubChannelOptions`

```ts
interface GitHubChannelOptions<E extends Env = Env> {
  webhookSecret: string;
  bodyLimit?: number;
  webhook(input: {
    c: Context<E>;
    delivery: GitHubWebhookDelivery;
  }): void | JsonValue | Response | Promise<void | JsonValue | Response>;
}
```

| Field           | Description                                     |
| --------------- | ----------------------------------------------- |
| `webhookSecret` | Secret configured on the GitHub webhook.        |
| `bodyLimit`     | Maximum request body in bytes. Default: 25 MiB. |
| `webhook`       | Receives every verified non-ping delivery.      |

Returning nothing produces an empty `200`. A JSON-compatible value becomes a
JSON response. An ordinary Hono or Fetch `Response` passes through unchanged.
A thrown callback falls through to Hono's framework error handler.

## `GitHubChannel`

```ts
interface GitHubChannel<E extends Env = Env> {
  readonly routes: readonly ChannelRoute<E>[];
  conversationKey(ref: GitHubIssueRef): string;
  parseConversationKey(id: string): GitHubIssueRef;
}
```

`routes` contains one `POST /webhook` declaration used by discovered channel
routing. A file named `channels/github.ts` is served at
`/channels/github/webhook` relative to the `flue()` mount.

Conversation keys are canonical identifiers, not authorization capabilities.
Pull requests use their issue number.

## Deliveries

Every verified non-ping delivery reaches `webhook` as a `GitHubWebhookDelivery`.
The package does not normalize, rename, or enumerate a fixed set of events: the
parsed event is forwarded with GitHub's own field names and nesting.

```ts
type GitHubWebhookDelivery = {
  [Name in WebhookEventName]: {
    name: Name;
    payload: EventPayloadMap[Name];
    deliveryId: string;
    hookId?: string;
    installationTarget?: { id: string; type: string };
  };
}[WebhookEventName];
```

| Field                | Description                                                               |
| -------------------- | ------------------------------------------------------------------------- |
| `name`               | The `X-GitHub-Event` value. Discriminates `payload`.                      |
| `payload`            | GitHub's parsed event, typed by `@octokit/webhooks-types`.                |
| `deliveryId`         | The `X-GitHub-Delivery` GUID. Manual redeliveries reuse it; dedupe on it. |
| `hookId`             | Header-derived hook id, when GitHub supplies one.                         |
| `installationTarget` | Header-derived installation target, when GitHub supplies one.             |

`name` is the discriminant. Narrowing on it narrows `payload` to the matching
native event — `name: 'issues'` gives an `IssuesEvent`, `name: 'pull_request'`
gives a `PullRequestEvent`, and so on. Within an event, branch on the native
`payload.action`. Read fields with GitHub's own names
(`payload.repository.owner.login`, `payload.issue.number`,
`payload.comment.in_reply_to_id`, `payload.installation?.id`).

Choosing which events to act on is application policy: subscribe to the minimum
set in GitHub and branch in the handler. Events without an `action` (for
example `push`) are forwarded like any other verified delivery.

The package re-exports the underlying types from `@octokit/webhooks-types`:

```ts
import type { EventPayloadMap, WebhookEvent, WebhookEventName } from '@flue/github';
```

GitHub `ping` is acknowledged internally and does not invoke `webhook`.
Signatures are checked against the exact request bytes before JSON parsing.
Ingress is JSON-only; form-encoded (`application/x-www-form-urlencoded`)
deliveries are rejected on content type before verification. The package does
not deduplicate `deliveryId`. Header-derived delivery, hook, and
installation-target metadata must not be treated as an authorization capability.

## Identity

```ts
interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}
```

## Errors

- `InvalidGitHubConversationKeyError`
- `InvalidGitHubInputError`, with structured `field`

See [GitHub setup](/docs/ecosystem/channels/github/) for composition with Octokit
and application-owned tools.
