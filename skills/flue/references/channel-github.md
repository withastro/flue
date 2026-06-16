# GitHub Channel

Use this for `@flue/github`, signed webhooks, Octokit tools, and issue or pull-request conversation keys.

## Setup

- Run `flue add channel github`.
- Install/use `@flue/github` for verified ingress.
- Use official `@octokit/rest` for outbound API calls.
- Required environment:
  - `GITHUB_WEBHOOK_SECRET`
  - `GITHUB_TOKEN`
- Configure webhook URL: `https://example.com/channels/github/webhook`.
- Use `application/json`; form-encoded deliveries are not accepted.

## Handler Notes

- Export `channel = createGitHubChannel({ webhookSecret, webhook })`.
- `delivery.name` is the `X-GitHub-Event` value and narrows `delivery.payload`.
- Payloads preserve GitHub field names and nesting.
- GitHub `ping` is acknowledged internally and does not reach the callback.
- There is no fixed supported-event list; subscribe in GitHub and branch in application code.

## Conversation And Tools

- Use `channel.conversationKey(issueRef)` for repository plus issue or pull request number.
- Pull requests use their issue number for issue comments.
- Bind outbound tools with `channel.parseConversationKey(id)` in trusted code.
- The model should choose the comment body only; trusted code binds owner, repo, issue number, and token.
- The channel-agent import cycle is acceptable when imported bindings are read only inside deferred callbacks or initializers.

## Delivery Behavior

- GitHub expects a `2xx` response within ten seconds.
- The package does not enforce a handler deadline; admit durable work quickly.
- GitHub does not auto-retry, but failed deliveries can be manually redelivered with the same delivery ID.
- Claim `delivery.deliveryId` in application storage before dispatch when duplicate admission matters.
- Octokit REST Fetch paths used by examples are tested in workerd with `nodejs_compat`; verify additional SDK methods.

