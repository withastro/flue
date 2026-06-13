---
title: GitHub Channel API
description: Reference for @flue/github.
lastReviewedAt: 2026-06-12
---

Import the GitHub channel API from `@flue/github`.

## `createGitHubChannel()`

```ts
function createGitHubChannel(options: GitHubChannelOptions): GitHubChannel;
```

Creates one fixed-credential GitHub integration. The channel is stateless and
does not deduplicate delivery ids.

### `GitHubChannelOptions`

| Field              | Type                      | Default            |
| ------------------ | ------------------------- | ------------------ |
| `webhookSecret`    | `string`                  | Required           |
| `token`            | `string`                  | Required           |
| `fetch`            | `typeof globalThis.fetch` | `globalThis.fetch` |
| `requestTimeoutMs` | `number`                  | `10000`            |

## `GitHubChannel`

### `routes.webhook()`

```ts
webhook(options?: GitHubWebhookRouteOptions): GitHubRouteHandler;
```

Returns an unbound-safe Fetch handler. `bodyLimit` is measured in bytes and
defaults to 25 MiB.

The route accepts `POST` JSON or form-encoded webhook payloads. Verified `ping`
and ignored event/action combinations return `204`.

### `on()`

```ts
on<TKey extends GitHubEventName>(
  type: TKey,
  handler: GitHubNotificationHandler<GitHubEvents[TKey]>,
): () => void;
```

Registers the sole handler for one event key and returns an idempotent,
registration-specific unsubscribe function.

Supported keys:

- `issues.opened`
- `issue_comment.created`
- `pull_request.opened`

Successful acknowledgement waits for the handler to finish.

### `client`

```ts
interface GitHubClient {
  commentOnIssue(ref: GitHubIssueRef, text: string, signal?: AbortSignal): Promise<void>;
  addLabels(ref: GitHubIssueRef, labels: string[], signal?: AbortSignal): Promise<void>;
}
```

Writes use the fixed GitHub API origin and are not retried automatically.

### `tools`

```ts
commentOnIssue(ref: GitHubIssueRef): ToolDefinition;
addLabels(ref: GitHubIssueRef): ToolDefinition;
```

Both factories snapshot the trusted destination. Model arguments contain only
comment text or labels.

### `GitHubIssueRef`

```ts
interface GitHubIssueRef {
  owner: string;
  repo: string;
  issueNumber: number;
}
```

Pull requests use their issue number.

### Conversation keys

```ts
conversationKey(ref: GitHubIssueRef): string;
parseConversationKey(id: string): GitHubIssueRef;
```

Keys are canonical identifiers, not authorization capabilities.

## Event envelope

```ts
interface GitHubWebhookEvent<TType extends string, TPayload> {
  type: TType;
  deliveryId: string;
  hookId?: string;
  installationTarget?: { id: string; type: string };
  installationId?: number;
  repository: GitHubRepositoryRef;
  payload: TPayload;
  raw: unknown;
}
```

## Errors

| Error                               | Structured fields                                     |
| ----------------------------------- | ----------------------------------------------------- |
| `DuplicateGitHubHandlerError`       | `event`                                               |
| `InvalidGitHubConversationKeyError` | —                                                     |
| `InvalidGitHubInputError`           | `field`                                               |
| `GitHubApiError`                    | `status`, `requestId`, `responseMessage`, `rateLimit` |
| `GitHubRateLimitError`              | Same as `GitHubApiError`                              |
| `GitHubTimeoutError`                | `timeoutMs`                                           |

See [GitHub setup](/docs/guide/channels/github/) for an end-to-end example.
