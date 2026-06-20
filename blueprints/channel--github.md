---
{
  "kind": "channel",
  "version": 1,
  "website": "https://github.com"
}
---

# Add a GitHub Channel to Flue

You are an AI coding agent adding verified GitHub webhook ingress and
application-owned GitHub API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
whether the application responds to issue comments, pull-request conversation
comments, inline review comments, opened issues, or another verified delivery.

Install `@flue/github` and the official `@octokit/rest@^22.0.1` SDK with the
project's package manager. Do not add a generic GitHub tool collection.

## Create the channel

Create `<source-dir>/channels/github.ts`. Adapt the imported agent and dispatched
input to the application, but preserve this ownership and routing shape:

```ts
// flue-blueprint: channel/github@1
import { createGitHubChannel } from '@flue/github';
import { defineTool, dispatch } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import assistant from '../agents/assistant.ts';

export const client = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Path: /channels/github/webhook
  async webhook({ delivery }) {
    // `delivery.name` is the X-GitHub-Event value and narrows `delivery.payload`
    // to the native @octokit/webhooks-types event. Filtering is application
    // policy: subscribe to the events you want in GitHub and branch here.
    if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
      const { repository, issue, comment } = delivery.payload;
      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: issue.number,
      };
      await dispatch(assistant, {
        id: channel.conversationKey(issueRef),
        input: {
          type: 'github.issue_comment.created',
          deliveryId: delivery.deliveryId,
          installationId: delivery.payload.installation?.id,
          issue: issueRef,
          sender: delivery.payload.sender,
          comment: { id: comment.id, body: comment.body },
        },
      });
      return;
    }

    if (delivery.name === 'pull_request_review_comment' && delivery.payload.action === 'created') {
      const { repository, pull_request, comment } = delivery.payload;
      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: pull_request.number,
      };
      await dispatch(assistant, {
        id: channel.conversationKey(issueRef),
        input: {
          type: 'github.pull_request_review_comment.created',
          deliveryId: delivery.deliveryId,
          installationId: delivery.payload.installation?.id,
          issue: issueRef,
          sender: delivery.payload.sender,
          comment: {
            id: comment.id,
            // Replies attach to the top-level review comment in a thread.
            threadId: comment.in_reply_to_id ?? comment.id,
            body: comment.body,
          },
        },
      });
      return;
    }
  },
});

export function commentOnIssue(ref: { owner: string; repo: string; issueNumber: number }) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: 'Comment on the GitHub issue or pull request bound to this agent.',
    parameters: {
      type: 'object',
      properties: { body: { type: 'string', minLength: 1 } },
      required: ['body'],
      additionalProperties: false,
    },
    async execute({ body }) {
      const result = await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
      return JSON.stringify({ commentId: result.data.id, url: result.data.html_url });
    },
  });
}
```

For Cloudflare projects, follow the project's existing credential convention.
Flue enables `nodejs_compat`, so `process.env` is supported; typed bindings
from `cloudflare:workers` are also valid when the project prefers them.
Octokit's typed REST request path must execute in workerd under that canonical
configuration, and the completed project must pass its actual Cloudflare
build.

If the user did not ask for issue comments, replace or omit the example tool.
Never let the model choose arbitrary owners, repositories, issue numbers, API
paths, or credentials unless the application has explicitly authorized that.

## Wire the agent

Bind the trusted conversation destination inside the agent initializer:

```ts
import { defineAgent } from '@flue/runtime';
import { channel, commentOnIssue } from '../channels/github.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [commentOnIssue(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported only because these imported
bindings are read inside deferred callbacks and initializers. Do not read the
agent binding while constructing `channel`.

## Credentials and verification

`GITHUB_WEBHOOK_SECRET` verifies inbound webhook bytes.
`GITHUB_TOKEN` authenticates outbound Octokit calls. They serve different
purposes. Follow existing project secret conventions and never invent values.

Configure the GitHub webhook content type as `application/json`. Ingress is
JSON-only; form-encoded (`application/x-www-form-urlencoded`) deliveries are
rejected before verification. Subscribe to the minimum event set the
application handles.

Run the project's typecheck and configured Flue build. Create a local JSON
payload and `X-Hub-Signature-256` HMAC to test success, invalid signatures,
the issue-comment and pull-request review-comment variants,
`/channels/github/webhook`, and the empty `200` default. GitHub expects a `2xx`
within ten seconds and does not auto-retry, so admit durable work quickly and
deduplicate on `deliveryId` when it matters. Exercise one Octokit call through a
fake Fetch transport in workerd. Do not contact GitHub.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
