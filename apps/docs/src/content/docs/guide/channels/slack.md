---
title: Slack
description: Configure Slack Events API, interactivity, thread tools, and identity checks.
---

`@flue/slack` supports one configured Slack application and workspace through
the Events API and selected interactivity payloads.

## Install and configure

```sh
pnpm add @flue/slack
```

Create or select a Slack app, install it to the target workspace, and configure:

- an Events API request URL such as `https://example.com/webhooks/slack/events`;
- an interactivity request URL such as `https://example.com/webhooks/slack/interactions`;
- the `app_mention` event, plus message events if your application handles them;
- bot scopes required for the events and outbound operations you use, such as posting messages or reactions.

Collect the signing secret, bot token, application id, and workspace id. See
Slack's documentation for
[verifying requests](https://docs.slack.dev/authentication/verifying-requests-from-slack/)
and [the Events API](https://docs.slack.dev/apis/events-api/).

```sh
SLACK_SIGNING_SECRET=...
SLACK_BOT_TOKEN=...
SLACK_APP_ID=...
SLACK_TEAM_ID=...
```

## Create the channel

```ts title="src/channels/slack.ts"
import { createSlackChannel } from '@flue/slack';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const slack = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  botToken: process.env.SLACK_BOT_TOKEN!,
  appId: process.env.SLACK_APP_ID!,
  teamId: process.env.SLACK_TEAM_ID!,
});

slack.on('app_mention', async (event) => {
  const thread = {
    teamId: event.teamId,
    channelId: event.payload.channelId,
    threadTs: event.payload.threadTs ?? event.payload.messageTs,
  };

  await dispatch(assistant, {
    id: slack.conversationKey(thread),
    input: {
      type: 'slack.app_mention',
      eventId: event.eventId,
      text: event.payload.text,
    },
  });
});
```

The package accepts `app_mention` and plain user `message` events. Message
subtypes and bot messages are acknowledged and ignored.

The signed application and workspace ids must match `appId` and `teamId` before
a handler runs. This fixed-workspace API does not support org-wide
installations.

## Mount both routes

```ts title="src/app.ts"
app.mount('/webhooks/slack/events', slack.routes.events());
app.mount('/webhooks/slack/interactions', slack.routes.interactions());
```

Both routes verify the exact raw body and reject request timestamps outside
Slack's five-minute freshness window.

## Handle actions

```ts
slack.onAction('approval_decision', async (event) => {
  await recordDecision({
    decision: event.value,
    userId: event.userId,
    messageTs: event.messageTs,
  });

  return { type: 'ack' };
});
```

Message-backed block actions return an empty acknowledgement. The signed
provider action remains available as `event.payload`; button `value` is also
normalized onto `event.value`.

Modal submissions registered with `onView(...)` can acknowledge or return
field validation errors. Agent-driven `response_url` replies are not exposed as
tools. The complete `event.raw` payload may contain a signed `response_url`;
never copy it into dispatch input, model-visible context, logs, or durable
session history.

## Add thread tools

```ts title="src/agents/assistant.ts"
export default createAgent(({ id }) => {
  const thread = slack.parseConversationKey(id);

  return {
    tools: [slack.tools.replyInThread(thread), slack.tools.addReaction(thread)],
  };
});
```

Replies target the bound thread. Reactions target its root message.

Slack may retry failed or timed-out Events API deliveries. Claim `eventId` in
application-owned durable storage when duplicate admission is unacceptable.

See the [`@flue/slack` reference](/docs/api/slack-channel/) for route options,
interaction responses, clients, tools, and errors.
