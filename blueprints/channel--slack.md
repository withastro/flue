---
{
  "kind": "channel",
  "version": 1,
  "website": "https://slack.com"
}
---

# Add a Slack Channel to Flue

You are an AI coding agent adding verified Slack HTTP ingress and
application-owned Slack Web API behavior to a Flue project.

## Inspect the project

Read local instructions, detect the package manager and target, and select the
first existing source root: `<root>/.flue/`, then `<root>/src/`, then
`<root>/`. Inspect existing agents, environment types, secret conventions, and
whether the application needs Events API, interactivity, slash commands, or a
combination.

Install `@flue/slack` and Slack's official
`@slack/web-api@^8.0.0-rc.1` SDK with the project's package manager. Version 8
uses Fetch and supports Cloudflare Workers with Flue's existing
`nodejs_compat` configuration.

## Create the channel

Create `<source-dir>/channels/slack.ts`. Adapt the imported agent and dispatched
input to the application:

```ts
// flue-blueprint: channel/slack@1
import { defineTool, dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import assistant from '../agents/assistant.ts';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/events
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;

    switch (payload.event.type) {
      case 'app_mention': {
        const event = payload.event;
        const thread = {
          teamId: payload.team_id,
          channelId: event.channel,
          threadTs: event.thread_ts ?? event.ts,
        };
        await dispatch(assistant, {
          id: channel.conversationKey(thread),
          input: {
            type: 'slack.app_mention',
            eventId: payload.event_id,
            text: event.text,
          },
        });
        return;
      }
      default:
        return;
    }
  },

  // Enable this surface only when the application handles interactions.
  // Path: /channels/slack/interactions
  // async interactions({ payload }) {
  //   if (payload.type === 'block_actions') {
  //     await handleActions(payload.actions);
  //   }
  // },

  // Enable this surface only when the application handles slash commands.
  // Path: /channels/slack/commands
  // async commands({ c, payload }) {
  //   return c.json({ response_type: 'ephemeral', text: `Received ${payload.command}` });
  // },
});

export function replyInThread(ref: { channelId: string; threadTs: string }) {
  return defineTool({
    name: 'reply_in_slack_thread',
    description: 'Reply in the Slack thread bound to this agent.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', minLength: 1 } },
      required: ['text'],
      additionalProperties: false,
    },
    async execute({ text }) {
      const result = await client.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text,
      });
      return JSON.stringify({ channel: result.channel, ts: result.ts });
    },
  });
}
```

Slack Events API callbacks receive the provider-native outer `payload`.
`payload.event` uses the official `SlackEvent` union re-exported by
`@flue/slack`. Preserve Slack field names and discriminants; do not add a
parallel normalized event model. Filtering bot messages, message subtypes, or
event families belongs in the application callback.

Omitting `events`, `interactions`, or `commands` omits that route. Leave unused
surfaces commented out. If the application does not need thread replies,
replace or omit the example tool. Keep channel ids, credentials, and arbitrary
Slack API methods out of tool arguments unless explicitly authorized.

`trigger_id`, `response_url`, and view `response_urls` are short-lived provider
capabilities. Use them only in immediate trusted request handling. Never copy
them into dispatch input, model context, logs, or durable session data.

## Wire the agent

```ts
import { defineAgent } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [replyInThread(channel.parseConversationKey(id))],
}));
```

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and initializers.

## Credentials and verification

`SLACK_SIGNING_SECRET` verifies exact request bytes. `SLACK_BOT_TOKEN`
authenticates outbound Web API calls. Follow project secret conventions and
never invent values. Slack URL verification is acknowledged internally after
signature verification. Workspace and enterprise identity remain in the
provider payload; add application-owned authorization only when the project
requires it.

Configure only required provider URLs:

```txt
/channels/slack/events
/channels/slack/interactions
/channels/slack/commands
```

Run the project typecheck and configured Node and Cloudflare builds. Generate
local `X-Slack-Signature` values from original synthetic Events API,
interaction, and slash-command payloads. Test URL verification, exact-byte
signature rejection, timestamp rejection, multi-workspace and enterprise
payload pass-through, optional route omission, default empty `200`, and normal
Hono error handling.

Exercise `WebClient` methods used by the application through fake Fetch
responses in Node or workerd. Do not contact Slack.

When updating an existing integration, inspect and compare it against this complete current blueprint, apply every relevant change while preserving customizations, and then add or update the marker in the primary marked file. This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
