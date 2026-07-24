# GitHub channel example

This example receives verified GitHub webhook ingress at
`/channels/github/webhook`, explicitly dispatches issue and pull-request
comments to an agent, derives a canonical issue or pull-request instance id,
and defines one application-owned Octokit tool bound to that destination.

`GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN` are required when the built application starts. Builds and type checks do not require live credentials.

Configure the GitHub webhook content type as `application/json`. Ingress is
JSON-only; form-encoded deliveries are not accepted. The route must receive the
unconsumed request body because signatures cover the exact bytes sent by GitHub.

The handler completes dispatch admission before returning `200`. GitHub expects
a `2xx` within ten seconds and does not auto-retry, so admit durable work
quickly and deduplicate on the delivery id when it matters. Failed deliveries
can be inspected and manually redelivered with the same delivery id.

The channel module exports both the ingress `channel` and the project-owned
Octokit `client`. The comment tool is deliberately narrow application policy,
not a generic tool supplied by `@flue/github`.

For inline review comments the handler derives the top-level thread comment id
from the native `comment.in_reply_to_id` field, but this example deliberately
uses one agent instance for the containing pull request and posts responses to
its conversation timeline.

The typed Octokit `issues.createComment()` path is exercised in workerd through
its Fetch transport with Flue's required `nodejs_compat` configuration and
without contacting GitHub.

The channel module imports the agent and the agent imports the channel. This
cycle is safe because the imported bindings are read only inside the webhook
callback and agent initializer, after module evaluation.

Instance ids validate syntax, not authorization. This agent is intentionally dispatch-only. Any direct agent route must independently authorize the caller-selected instance id before deriving outbound tools from it.
