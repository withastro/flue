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
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and
whether the application responds to issue comments, pull-request conversation
comments, inline review comments, opened issues, or another verified delivery.

Install `@flue/github` and the official `@octokit/rest@^22.0.1` SDK with the
project's package manager. Do not add a generic GitHub tool collection.

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/github.ts`. Adapt the imported agent and dispatched
message to the application, but preserve this ownership and routing shape:

```ts
// flue-blueprint: channel/github@1
import { createGitHubChannel } from '@flue/github';
import { defineTool, dispatch } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

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
      const { repository, issue, comment, sender, installation } = delivery.payload;
      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: issue.number,
      };
      await dispatch(Assistant, {
        id: channel.instanceId(issueRef),
        // Recorded once when this event creates the instance; ignored after.
        initialData: {
          owner: issueRef.owner,
          repo: issueRef.repo,
          issueNumber: issueRef.issueNumber,
          openedBy: issue.user.login,
          title: issue.title,
        },
        message: {
          kind: 'signal',
          type: 'github.issue_comment.created',
          body: comment.body,
          attributes: {
            deliveryId: delivery.deliveryId,
            ...(installation === undefined ? {} : { installationId: String(installation.id) }),
            owner: issueRef.owner,
            repo: issueRef.repo,
            issueNumber: String(issueRef.issueNumber),
            sender: sender.login,
            title: issue.title,
            commentId: String(comment.id),
          },
        },
      });
      return;
    }

    if (delivery.name === 'pull_request_review_comment' && delivery.payload.action === 'created') {
      const { repository, pull_request, comment, sender, installation } = delivery.payload;
      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: pull_request.number,
      };
      await dispatch(Assistant, {
        id: channel.instanceId(issueRef),
        // Recorded once when this event creates the instance; ignored after.
        initialData: {
          owner: issueRef.owner,
          repo: issueRef.repo,
          issueNumber: issueRef.issueNumber,
          openedBy: pull_request.user.login,
          title: pull_request.title,
        },
        message: {
          kind: 'signal',
          type: 'github.pull_request_review_comment.created',
          body: comment.body,
          attributes: {
            deliveryId: delivery.deliveryId,
            ...(installation === undefined ? {} : { installationId: String(installation.id) }),
            owner: issueRef.owner,
            repo: issueRef.repo,
            issueNumber: String(issueRef.issueNumber),
            sender: sender.login,
            title: pull_request.title,
            commentId: String(comment.id),
            // Replies attach to the top-level review comment in a thread.
            threadId: String(comment.in_reply_to_id ?? comment.id),
            path: comment.path,
            ...(comment.line === null || comment.line === undefined
              ? {}
              : { line: String(comment.line) }),
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
    input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { body } = data;
      const result = await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
      return { commentId: result.data.id, url: result.data.html_url };
    },
  });
}
```

## Mount the channel

A channel serves HTTP routes only where `app.ts` mounts it. Mount the
channel's router explicitly:

```ts
// app.ts
import { Hono } from 'hono';
import { channel } from './channels/github.ts';

const app = new Hono();
app.route('/channels/github', channel.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/github` mount; a different mount path shifts every
provider URL accordingly.

For Cloudflare projects, follow the project's existing credential convention.
Flue enables `nodejs_compat`, so `process.env` is supported; typed bindings
from `cloudflare:workers` are also valid when the project prefers them.
Octokit's typed REST request path must execute in workerd under that canonical
configuration, and the completed project must pass its actual Cloudflare
build.

If the user did not ask for issue comments, replace or omit the example tool.
Never let the model choose arbitrary owners, repositories, issue numbers, API
paths, or credentials unless the application has explicitly authorized that.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the structured issue reference — the agent reads it with
`useInitialData()` instead of parsing the instance id — plus small
instance-constant context like who opened the issue or pull request and its
title. Per-message facts stay on the signal's `attributes`.

## Wire the agent

Bind the trusted conversation destination inside the agent component:

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { commentOnIssue } from '../channels/github.ts';

const initialDataSchema = v.object({
	owner: v.string(),
	repo: v.string(),
	issueNumber: v.number(),
	openedBy: v.string(),
	title: v.string(),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the GitHub channel dispatch.');
	useTool(commentOnIssue(data));
	return `Review the issue and post a concise triage comment when appropriate. "${data.title}" was opened by ${data.openedBy}.`;
}

Assistant.initialData = initialDataSchema;
```

The `initialData` static validates the dispatched `initialData` when the
instance is created; `useInitialData()` returns the parsed value on every
render.

The `'use agent'` directive (the module's first statement) is what registers
the agent with the application — `dispatch(...)` from the channel callback
needs no `app.ts` mounting. Add
`app.route('/agents/<name>', createAgentRouter(Assistant))` (from
`@flue/runtime/routing`) in `app.ts` only when the agent
should also be reachable over HTTP directly.

The channel-agent import cycle is supported only because these imported
bindings are read inside deferred callbacks and agent function bodies. Do not
read the agent binding while constructing `channel`.

## Credentials and verification

`GITHUB_WEBHOOK_SECRET` verifies inbound webhook bytes.
`GITHUB_TOKEN` authenticates outbound Octokit calls. They serve different
purposes. Follow existing project secret conventions and never invent values.

Point the GitHub webhook URL at the channel's mount path in `app.ts` plus the
route suffix — `/channels/github/webhook` with the conventional
`app.route('/channels/github', ...)` mount.
Configure the GitHub webhook content type as `application/json`. Ingress is
JSON-only; form-encoded (`application/x-www-form-urlencoded`) deliveries are
rejected before verification. Subscribe to the minimum event set the
application handles.

Run the project typecheck and `vite build` for the configured target. Create a
local JSON payload and `X-Hub-Signature-256` HMAC to test success, invalid
signatures,
the issue-comment and pull-request review-comment variants,
`/channels/github/webhook`, and the empty `200` default. GitHub expects a `2xx`
within ten seconds and does not auto-retry, so admit durable work quickly and
deduplicate on `deliveryId` when it matters. Exercise one Octokit call through a
fake Fetch transport in workerd. Do not contact GitHub.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
