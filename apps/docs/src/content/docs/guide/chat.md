---
title: Chat SDK
description: Connect Chat SDK adapters and chat-side state to continuing Flue agents.
---

[Chat SDK](https://chat-sdk.dev/docs) provides a cross-platform conversation
model, provider adapters, and chat-side state management. Use it when those
abstractions fit better than Flue's provider-specific
[first-party channels](/docs/guide/channels/).

Your application still owns the Flue boundary:

```txt
Chat SDK adapter
  → application event handler
  → dispatch(agent, ...)
  → continuing Flue agent session
```

## Dispatch accepted messages

This GitHub adapter example requires `GITHUB_WEBHOOK_SECRET` and `GITHUB_TOKEN`.
Use the credentials and adapter configuration required by your selected Chat
SDK provider.

```ts title="src/chat.ts"
import { createGitHubAdapter } from '@chat-adapter/github';
import { createMemoryState } from '@chat-adapter/state-memory';
import { dispatch, type CreatedAgent } from '@flue/runtime';
import { Chat } from 'chat';

export const bot = new Chat({
  userName: 'support-bot',
  adapters: {
    github: createGitHubAdapter({
      webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
      token: process.env.GITHUB_TOKEN!,
      userName: 'support-bot',
    }),
  },
  state: createMemoryState(),
});

export function connectChat(agent: CreatedAgent) {
  bot.onNewMention(async (thread, message) => {
    await dispatch(agent, {
      id: thread.id,
      input: {
        type: 'chat.message',
        messageId: message.id,
        text: message.text,
      },
    });
  });
}
```

The adapter verifies and interprets provider requests. Your handler chooses the
agent, instance id, and normalized input.

Mount the adapter route in the same application as Flue:

```ts title="src/app.ts"
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { bot, connectChat } from './chat.ts';

connectChat(assistant);

const app = new Hono();
app.post('/webhooks/github', (c) => bot.webhooks.github(c.req.raw));
app.route('/', flue());

export default app;
```

On targets with background request lifecycles, attach asynchronous adapter work
to the platform lifecycle when required. `examples/chat-sdk/` demonstrates the
Cloudflare integration.

## Choose instance identity

A chat thread is a useful default agent-instance boundary. Each thread then has
its own continuing session history.

An account, workspace, or repository can be the boundary instead. In that
design, store or verify the permitted outbound destination separately. A parsed
thread or instance id is not authorization.

Dispatched chat input is an operation inside an agent instance, not a workflow
run.

## Scope reply tools

Receiving a message does not automatically post the agent's text back to the
provider. Give the agent an explicit tool whose destination is selected by
trusted application code:

```ts title="src/agents/assistant.ts"
import { createAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { bot } from '../chat.ts';

export default createAgent(({ id }) => ({
  tools: [
    defineTool({
      name: 'reply_to_chat_thread',
      description: 'Post a response into the current chat thread.',
      parameters: v.object({ text: v.string() }),
      execute: async ({ text }) => {
        await bot.thread(id).post(text);
        return 'Reply sent.';
      },
    }),
  ],
}));
```

The model chooses content, not credentials or destination ids. A direct agent
route must independently authorize a caller-selected instance before deriving
this tool.

## Keep state responsibilities separate

| Concern                                                                 | Owner                  |
| ----------------------------------------------------------------------- | ---------------------- |
| Thread subscriptions, webhook deduplication, and chat-side coordination | Chat SDK state adapter |
| Agent sessions, submissions, and runtime capabilities                   | Flue                   |

The in-memory Chat SDK state adapter is suitable for local development. Use a
persistent adapter when chat-side subscriptions or coordination must survive
restarts or multiple application instances.

See the [Chat SDK documentation](https://chat-sdk.dev/docs) for supported
adapters and state backends. See [Channels](/docs/guide/channels/) for
first-party GitHub, Slack, and Discord integrations or a custom Fetch-based
channel.
