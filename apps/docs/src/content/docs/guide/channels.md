---
title: Channels
description: Receive verified provider events and connect them to Flue agents.
---

A channel receives provider HTTP events, verifies and normalizes them, and lets
your application decide what happens next. Flue provides ingress packages for:

| Provider | Package         | Discovered routes                                          |
| -------- | --------------- | ---------------------------------------------------------- |
| GitHub   | `@flue/github`  | `/channels/<file>/webhook`                                 |
| Slack    | `@flue/slack`   | `/channels/<file>/events`, `/channels/<file>/interactions` |
| Discord  | `@flue/discord` | `/channels/<file>/interactions`                            |
| Teams    | `@flue/teams`   | `/channels/<file>/activities`                              |

The packages own signature verification, body limits, provider handshakes,
identity checks, typed event normalization, and acknowledgement behavior. They
do not wrap outbound provider APIs or supply generic model tools.

## Add a provider

Use `flue add` to give your coding agent the complete integration recipe:

```sh
flue add github --print | codex
flue add slack --print | codex
flue add discord --print | codex
flue add teams --print | codex
```

The recipe installs the ingress package and an established provider SDK or
narrow Fetch client, then creates an editable `channels/<provider>.ts` module
that exports:

- `channel`, the verified inbound integration discovered by Flue;
- `client`, the project-owned provider SDK client;
- any narrow `defineTool(...)` values justified by your application.

For another provider, start from its documentation:

```sh
flue add https://provider.example/webhooks --category channel --print | codex
```

See the provider guides for [GitHub](/docs/guide/channels/github/),
[Slack](/docs/guide/channels/slack/), and
[Discord](/docs/guide/channels/discord/),
[Microsoft Teams](/docs/guide/channels/teams/), or
[build a custom channel](/docs/guide/build-your-own-channel/).

## File-based routing

Each immediate file beneath `channels/` exports one named `channel` binding:

```txt
src/channels/github.ts  -> /channels/github/webhook
src/channels/slack.ts   -> /channels/slack/events
                          /channels/slack/interactions
src/channels/teams.ts   -> /channels/teams/activities
```

The filename defines the channel namespace. Provider packages define fixed,
non-empty route suffixes. The namespace itself, such as `/channels/github`, is
not an endpoint.

No `app.ts` is required. If an authored application mounts `flue()` beneath an
outer prefix, channels receive that prefix with agents and workflows:

```ts
app.route('/api', flue());
```

publishes `/api/channels/github/webhook`. An authored application cannot move
one discovered channel independently.

Generated channel modules include an exact default path comment immediately
above each handler:

```ts
// Path: /channels/github/webhook
async webhook({ event }) {
  // ...
}
```

## Handle verified events

The constructor receives one callback per provider protocol surface. The
callback runs only after verification and normalization:

```ts
export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Path: /channels/github/webhook
  async webhook({ c, event }) {
    switch (event.type) {
      case 'issues.opened':
      case 'pull_request.opened':
        await dispatch(assistant, {
          id: channel.conversationKey({
            owner: event.repository.owner,
            repo: event.repository.name,
            issueNumber:
              event.type === 'issues.opened'
                ? event.payload.issue.number
                : event.payload.pullRequest.number,
          }),
          input: {
            type: `github.${event.type}`,
            deliveryId: event.deliveryId,
          },
        });
        return;
      default:
        return;
    }
  },
});
```

The callback receives the authentic Hono context as `c`. Return `c.json(...)`,
`c.text(...)`, or another `Response` for full response control. A plain
JSON-compatible return value becomes a JSON response. When the provider allows
an empty acknowledgement, returning nothing produces an empty `200`.

Slack surfaces are optional: omitting `events` or `interactions` means that
route is not published. Discord interactions require a provider response.

## Own the SDK and tools

Provider APIs are broad and provider-specific. Initialize the established SDK
in project code, export it, and define only the tools your agent needs:

```ts
export const client = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export function commentOnIssue(ref: GitHubIssueRef) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: 'Comment on the GitHub issue bound to this agent.',
    parameters: v.object({ body: v.string() }),
    async execute({ body }) {
      await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
      return 'Comment posted.';
    },
  });
}
```

Bind credentials and destinations in trusted application code. Let the model
select only the content or intentionally variable options. Conversation keys
identify destinations; they do not authorize caller-selected agent ids.

## Acknowledgement and replay

Channel packages are stateless and do not deduplicate deliveries.

| Provider             | Failure behavior                                                       |
| -------------------- | ---------------------------------------------------------------------- |
| GitHub               | Failed deliveries can be inspected and manually redelivered.           |
| Slack Events API     | Slack may retry and supplies retry metadata.                           |
| Slack interactivity  | Requires a prompt acknowledgement and is not a dependable retry queue. |
| Discord interactions | Failures are user-visible and do not provide dependable redelivery.    |
| Teams activities     | Use `activityId` when the application needs duplicate protection.      |

Handlers wait for application work such as `dispatch(...)` admission before
acknowledging. Deadlines cannot forcibly stop arbitrary callback code. Claim a
delivery or interaction id in application-owned durable storage when duplicate
admission is unacceptable.

Keep raw payloads, credentials, Slack `response_url` values, Discord
interaction tokens, and other short-lived capabilities out of model context,
logs, dispatched input, and durable session history.

## Targets

The first-party ingress packages use Fetch and Web Crypto and are tested on
Node and workerd. Outbound SDK compatibility is separate: validate the SDK and
operations selected by your application against its actual target. Recipes may
choose a narrower Fetch client when a provider's Node SDK is not suitable for
Cloudflare.
