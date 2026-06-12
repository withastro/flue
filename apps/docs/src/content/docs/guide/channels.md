---
title: Channels
description: Receive Slack and GitHub events through verified application routes.
---

Channels are provider packages for application-owned ingress. They verify provider webhooks, normalize the events Flue supports, and provide provider-native outbound clients and tools. Your application still decides which events matter, which agent receives them, and what input the model should see.

Use channels when a provider webhook should wake up a continuing agent:

```txt
provider webhook
  -> channel.fetch(request)
  -> typed event handler
  -> dispatch(agent, ...)
  -> continuing Flue agent session
```

There is no channel discovery convention, generated `/channels/*` route, or one-channel-to-one-agent coupling. A single channel can dispatch to multiple agents, and a single agent can receive input from multiple providers.

## Install

Install the first-party channel package:

```sh
pnpm add @flue/channels
```

The package exposes implemented provider subpaths only:

```ts
import { createGitHubChannel } from '@flue/channels/github';
import { createSlackChannel } from '@flue/channels/slack';
```

Each channel has one mount surface: `channel.fetch(request)`. Mount it from `src/app.ts` anywhere a Fetch handler fits. The same code shape works on Node.js and Cloudflare because Flue applications are Hono applications in both targets.

## Slack

Create the Slack channel in a normal module, register event handlers, and dispatch accepted events yourself:

```ts title="src/channels/slack.ts"
import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/channels/slack';
import assistant from '../agents/slack-assistant.ts';

export type SlackEnv = {
  SLACK_BOT_TOKEN?: string;
  SLACK_SIGNING_SECRET?: string;
};

export const slack = createSlackChannel<SlackEnv>({
  signingSecret: ({ context }) => context?.SLACK_SIGNING_SECRET,
  botToken: ({ context }) => context?.SLACK_BOT_TOKEN,
});

slack.on('app_mention', async (event) => {
  await dispatch(assistant, {
    id: slack.conversationKey(event),
    input: {
      type: 'slack.app_mention',
      eventId: event.eventId,
      teamId: event.teamId,
      channelId: event.channelId,
      threadTs: event.threadTs,
      messageTs: event.messageTs,
      text: event.text,
      userId: event.userId,
    },
  });
});
```

Mount the channel route next to Flue:

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { slack } from './channels/slack.ts';

const app = new Hono();

app.post('/slack/events', (c) => slack.fetch(c.req.raw, process.env));
app.route('/', flue());

export default app;
```

A successful handler returns `200` to Slack. Invalid signatures return `401`, unsupported methods return `405`, and thrown handler errors return `500` so Slack can retry.

Give the agent provider-native tools for allowed outbound actions. The application chose the agent instance id with `slack.conversationKey(event)`, so the agent can recover the trusted destination from its own id:

```ts title="src/agents/slack-assistant.ts"
import { createAgent } from '@flue/runtime';
import { slack, type SlackEnv } from '../channels/slack.ts';

export default createAgent(({ id, env }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Help the user in Slack. Reply in the Slack thread when useful.',
  tools: [
    slack.tools.replyInThread(slack.parseConversationKey(id), env as SlackEnv),
  ],
}));
```

The model chooses the reply text. Trusted application code chooses the Slack team, channel, and thread.

## GitHub

GitHub uses the same route and dispatch model:

```ts title="src/channels/github.ts"
import { dispatch } from '@flue/runtime';
import { createGitHubChannel } from '@flue/channels/github';
import triage from '../agents/triage.ts';

export type GitHubEnv = {
  GITHUB_TOKEN?: string;
  GITHUB_WEBHOOK_SECRET?: string;
};

export const github = createGitHubChannel<GitHubEnv>({
  webhookSecret: ({ context }) => context?.GITHUB_WEBHOOK_SECRET,
  token: ({ context }) => context?.GITHUB_TOKEN,
});

github.on('issues.opened', async (event) => {
  await dispatch(triage, {
    id: github.conversationKey({
      owner: event.owner,
      repo: event.repo,
      issueNumber: event.number,
    }),
    input: {
      type: 'github.issues.opened',
      deliveryId: event.deliveryId,
      owner: event.owner,
      repo: event.repo,
      issueNumber: event.number,
      title: event.issue.title,
      body: event.issue.body,
      senderLogin: event.senderLogin,
    },
  });
});
```

Mount it from `src/app.ts`:

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { github } from './channels/github.ts';

const app = new Hono();

app.post('/github/webhooks', (c) => github.fetch(c.req.raw, process.env));
app.route('/', flue());

export default app;
```

GitHub handlers are available for every signed webhook delivery. Events with an `action` use `<event>.<action>` names such as `workflow_run.completed`; events without an action use the event name, such as `push`. The `*` handler observes every accepted delivery. The issue and pull request events used above have narrower TypeScript shapes for common conversation workflows.

The outbound tools follow GitHub's issue API, which also works for pull requests:

```ts title="src/agents/triage.ts"
import { createAgent } from '@flue/runtime';
import { github, type GitHubEnv } from '../channels/github.ts';

export default createAgent(({ id, env }) => {
  const issue = github.parseConversationKey(id);

  return {
    model: 'anthropic/claude-haiku-4-5',
    instructions: 'Triage the GitHub issue. Comment only when a response is useful.',
    tools: [
      github.tools.commentOnIssue(issue, env as GitHubEnv),
      github.tools.addLabels(issue, env as GitHubEnv),
    ],
  };
});
```

## Identity

Choose an agent instance id that represents the continuing conversation. For Slack threads, `slack.conversationKey(event)` encodes the trusted team, channel, and thread timestamp. For GitHub issues and pull requests, `github.conversationKey(...)` encodes the trusted repository and issue number.

Dispatched input lands in the agent instance's default session. If an outbound tool needs the provider destination, include that destination in the instance id or load it from your own trusted state.

## Idempotency

Channels surface provider delivery identifiers but do not store or dedupe provider events. Slack events include `event.eventId` and retry headers. GitHub events include `event.deliveryId`.

This keeps channels portable and stateless. If duplicate provider deliveries would cause duplicate side effects in your application, claim the provider delivery id in your own durable store before calling `dispatch(...)`, or make the downstream action idempotent.

## Configuration

Secrets are resolved lazily. A missing Slack signing secret is reported when the Slack route receives its first request. A missing Slack bot token is reported only when code calls the Slack client or a Slack tool. GitHub webhook secrets and tokens behave the same way.

`channel.fetch(request, context)` passes `context` to lazy config resolvers. In a Hono app, pass `process.env` on Node.js and `c.env` on Cloudflare. Agent tools use the same context shape: pass `env` from `createAgent(({ env }) => ...)` when a tool needs a provider token.

## Chat SDK

Chat SDK remains a separate integration option for teams that want Chat SDK's adapter and state model. Use `@flue/channels` when you want first-party provider helpers with explicit Flue dispatch. Use Chat SDK when you want Chat SDK to own the chat adapter behavior and then dispatch accepted Chat SDK events into Flue. See [Chat](/docs/guide/chat/) and [Durable Chat SDK on Cloudflare](/docs/guide/chat-sdk-cloudflare/) for that path.

## Next steps

- [Routing](/docs/guide/routing/) — mount provider webhooks alongside Flue routes.
- [Agents](/docs/guide/building-agents/) — build continuing agents for dispatched input.
- [Tools](/docs/guide/tools/) — control external side effects with model-callable tools.
- [Chat](/docs/guide/chat/) — compare direct provider channels with Chat SDK.
