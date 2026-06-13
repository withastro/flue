---
title: GitHub
description: Configure signed GitHub webhooks and issue or pull-request tools.
---

`@flue/github` accepts selected repository webhook events and provides
fixed-origin comment and label writes.

## Install and configure

```sh
pnpm add @flue/github
```

Create a repository or organization webhook that points to your deployed route,
for example:

```txt
https://example.com/webhooks/github
```

Set a webhook secret and select `application/json` or
`application/x-www-form-urlencoded`. Subscribe to the events your application
handles:

- Issues
- Issue comments
- Pull requests

Create a token authorized for the repositories and API writes your application
uses. See GitHub's documentation for
[creating webhooks](https://docs.github.com/en/webhooks/using-webhooks/creating-webhooks)
and [repository permissions](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens).

Provide the credentials to the application:

```sh
GITHUB_WEBHOOK_SECRET=...
GITHUB_TOKEN=...
```

## Create the channel

```ts title="src/channels/github.ts"
import { createGitHubChannel } from '@flue/github';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const github = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  token: process.env.GITHUB_TOKEN!,
});

github.on('issues.opened', async (event) => {
  const issue = {
    owner: event.repository.owner,
    repo: event.repository.name,
    issueNumber: event.payload.issue.number,
  };

  await dispatch(assistant, {
    id: github.conversationKey(issue),
    input: {
      type: 'github.issues.opened',
      deliveryId: event.deliveryId,
      title: event.payload.issue.title,
      body: event.payload.issue.body,
    },
  });
});
```

Supported handler keys are `issues.opened`, `issue_comment.created`, and
`pull_request.opened`. Verified `ping` deliveries and unknown event/action
combinations are acknowledged without invoking a handler.

## Mount the webhook

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { github } from './channels/github.ts';

const app = new Hono();
app.mount('/webhooks/github', github.routes.webhook());
app.route('/', flue());

export default app;
```

The route verifies the signature against the exact original bytes. Mount it
before middleware that consumes or rewrites the body.

## Add issue tools

```ts title="src/agents/assistant.ts"
import { createAgent } from '@flue/runtime';
import { github } from '../channels/github.ts';

export default createAgent(({ id }) => {
  const issue = github.parseConversationKey(id);

  return {
    tools: [github.tools.commentOnIssue(issue), github.tools.addLabels(issue)],
  };
});
```

Pull requests use their issue number because GitHub's issue comment and label
APIs also address pull requests through the issues surface.

GitHub expects a prompt webhook response and does not automatically retry every
failed delivery. Use `deliveryId` for application-owned idempotency and GitHub's
manual redelivery tools when required.

See the [`@flue/github` reference](/docs/api/github-channel/) for route options,
event envelopes, clients, tools, and errors.
