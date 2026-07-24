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
`<root>/`. Inspect existing agents, `app.ts` (the application's route map),
environment types, secret conventions, and whether the application needs
Events API, interactivity, slash commands, or a combination.

Install `@flue/slack` and Slack's official
`@slack/web-api@^8.0.0-rc.1` SDK with the project's package manager. Version 8
uses Fetch and supports Cloudflare Workers with Flue's existing
`nodejs_compat` configuration.

Install `valibot` using the project's existing dependency conventions.

## Create the channel

Create `<source-dir>/channels/slack.ts`. Adapt the imported agent and dispatched
message to the application:

```ts
// flue-blueprint: channel/slack@1
import { defineTool, dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import * as v from 'valibot';
import { Assistant } from '../agents/assistant.ts';

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
        await dispatch(Assistant, {
          id: channel.instanceId(thread),
          // Recorded once when this event creates the instance; ignored after.
          initialData: {
            channelId: thread.channelId,
            threadTs: thread.threadTs,
            startedBy: event.user,
            startedAt: new Date(Number(event.ts) * 1000).toISOString(),
          },
          message: {
            kind: 'signal',
            type: 'slack.app_mention',
            body: event.text,
            attributes: { eventId: payload.event_id },
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
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ data }) {
      const { text } = data;
      const result = await client.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text,
      });
      return {
        ...(result.channel === undefined ? {} : { channel: result.channel }),
        ...(result.ts === undefined ? {} : { ts: result.ts }),
      };
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
import { channel as slack } from './channels/slack.ts';

const app = new Hono();
app.route('/channels/slack', slack.route());

export default app;
```

`channel.route()` is a pure router factory serving the channel's routes
relative to the mount path. The `// Path:` comments in this guide assume the
conventional `/channels/slack` mount; a different mount path shifts every
provider URL accordingly.

Slack Events API callbacks receive the provider-native outer `payload`.
`payload.event` uses the official `SlackEvent` union re-exported by
`@flue/slack`. Preserve Slack field names and discriminants; do not add a
parallel normalized event model. Filtering bot messages, message subtypes, or
event families belongs in the application callback.

Omitting `events`, `interactions`, or `commands` omits that route. Leave unused
surfaces commented out. If the application does not need thread replies,
replace or omit the example tool. Keep channel ids, credentials, and arbitrary
Slack API methods out of tool arguments unless explicitly authorized.

`initialData` is the instance's creation data: recorded once when the event creates
the instance and ignored afterward, so the channel passes it on every
dispatch. It carries the structured thread facts — the agent reads them with
`useInitialData()` instead of parsing the instance id — plus small
instance-constant context like who started the conversation. Per-message facts
stay on the signal's `attributes`.

`trigger_id`, `response_url`, and view `response_urls` are short-lived provider
capabilities. Use them only in immediate trusted request handling. Never copy
them into a dispatched message, model context, logs, or durable session data.

## Wire the agent

```ts
'use agent';
import { useInitialData, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { replyInThread } from '../channels/slack.ts';

const initialDataSchema = v.object({
	channelId: v.string(),
	threadTs: v.string(),
	startedBy: v.optional(v.string()),
	startedAt: v.pipe(v.string(), v.isoTimestamp()),
});

export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	const data = useInitialData<v.InferOutput<typeof initialDataSchema>>();
	if (!data) throw new Error('This agent is created by the Slack channel dispatch.');
	useTool(replyInThread(data));
	const startedBy = data.startedBy ? ` by <@${data.startedBy}>` : '';
	return `Reply in the bound Slack thread when appropriate. This conversation was started${startedBy} at ${data.startedAt}.`;
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

The channel-agent import cycle is supported because imported bindings are read
inside deferred callbacks and agent function bodies.

## Credentials and verification

`SLACK_SIGNING_SECRET` verifies exact request bytes. `SLACK_BOT_TOKEN`
authenticates outbound Web API calls. Follow project secret conventions and
never invent values. Slack URL verification is acknowledged internally after
signature verification. Workspace and enterprise identity remain in the
provider payload; add application-owned authorization only when the project
requires it.

Configure only required provider URLs. Each is the channel's mount path in
`app.ts` plus the route suffix — with the conventional
`app.route('/channels/slack', ...)` mount:

```txt
/channels/slack/events
/channels/slack/interactions
/channels/slack/commands
```

Run the project typecheck and `vite build` for the configured target. Generate
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
