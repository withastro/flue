---
title: Chat
description: Connect conversational platforms to continuing Flue agents and controlled outbound actions.
---

Connect chat platforms to continuing agents through application-owned event handling and explicit outbound tools. This guide shows the pattern for webhook-based integrations directly and with [Chat SDK](https://chat-sdk.dev/docs), a convenient integration for conversational platforms.

## Receive chat events in your application

For a webhook-based integration, chat ingress belongs in your application routes rather than in individual agent modules. The route or a module called by that route turns the provider request into the small piece of input an agent should see:

```txt
platform webhook
  → application-owned verification and message handling
  → dispatch(agent, ...)
  → continuing Flue agent session
```

For example, an application using its own platform integration can accept a message and dispatch it to an assistant:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { parseVerifiedChatMessage } from './chat/platform.ts';

const app = new Hono();

app.post('/webhooks/chat', async (c) => {
  const message = await parseVerifiedChatMessage(c.req.raw);

  if (!message) return c.text('ok');

  await dispatch(assistant, {
    id: message.threadId,
    input: {
      type: 'chat.message',
      messageId: message.id,
      text: message.text,
    },
  });

  return c.text('ok');
});

app.route('/', flue());

export default app;
```

`parseVerifiedChatMessage(...)` represents application code written against the platform integration you choose. It should reject untrusted requests, ignore trusted events that should not become agent input, and return only the information the agent needs.

This is different from exposing a direct agent prompt route. The chat platform does not select `/agents/<name>/<id>` or supply a conversation identity to an agent endpoint. Your webhook handler makes that mapping after accepting the platform event. An agent that only receives chat input through `dispatch(...)` does not need to export an HTTP or WebSocket transport.

`dispatch(...)` accepts the message for asynchronous processing. It does not wait for the agent to compose or post a reply.

## Implement this boundary with Chat SDK

[Chat SDK](https://chat-sdk.dev/docs) can provide the platform-facing portion of this integration. Its adapter receives provider webhooks and its event handlers expose chat concepts such as mentions, threads, and messages. A handler can then dispatch accepted messages to Flue:

```ts title="src/chat.ts"
import { createGitHubAdapter } from '@chat-adapter/github';
import { createMemoryState } from '@chat-adapter/state-memory';
import { dispatch, type CreatedAgent } from '@flue/runtime';
import { Chat } from 'chat';

export const bot = new Chat({
  userName: 'support-bot',
  adapters: {
    github: createGitHubAdapter(),
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

Mount the adapter webhook route in the same application boundary:

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

The provider still calls your application webhook. Chat SDK interprets the provider request and determines that this event is a new mention; your registered handler determines which agent and Flue identity receive the normalized message. You can register additional supported handlers when a conversation should continue after its initial mention.

On targets with background request lifecycles, such as Cloudflare Workers, attach asynchronous adapter work to the platform lifecycle when required. The Chat SDK example in `examples/chat-sdk/` demonstrates this integration.

## Choose instance identity

A chat thread is a useful default boundary for a conversational agent. In the examples above, `thread.id` or `message.threadId` is used as the agent instance `id`. Each thread gets its own agent instance with its own conversation history.

An application with an account, workspace, or repository boundary may use that boundary as the instance `id` instead. In that design, store or verify the permitted destination before any outbound action; a model-selected thread identifier is not an authorization boundary.

A dispatched chat message is an operation in an agent instance, not a workflow run. Use agent and operation observation for chat-triggered activity rather than workflow run history.

## Let an agent reply through tools

Receiving a platform event does not automatically send the agent's text back to that platform. Give an agent an explicit outbound tool when replying is an allowed action. With the thread-as-instance identity above, a Chat SDK-backed reply tool can be scoped to the thread chosen by application code:

```ts title="src/agents/assistant.ts"
import { Type, createAgent, defineTool } from '@flue/runtime';
import { bot } from '../chat.ts';

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Reply in the current chat thread when a response is appropriate.',
  tools: [
    defineTool({
      name: 'reply_to_chat_thread',
      description: 'Post a response into the current chat thread.',
      parameters: Type.Object({ text: Type.String() }),
      execute: async ({ text }) => {
        await bot.thread(id).post(text);
        return 'Reply sent.';
      },
    }),
  ],
}));
```

The model chooses the reply text, but trusted application code chooses where it can be sent. Apply the same rule to reactions, edits, attachments, or provider-native actions: keep credentials and authorized destinations outside model-selected tool arguments.

If you separately expose this agent through a direct HTTP or WebSocket route, that route must verify that its caller may select the requested agent instance. See [Tools](/docs/guide/tools/) for capability boundaries and [Routing](/docs/guide/routing/) for protecting public application surfaces.

## Keep chat-side state and agent state separate

A chat integration usually has two kinds of continuing state:

| Concern                                                                 | Owner                                                       |
| ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| Thread subscriptions, webhook deduplication, and chat-side coordination | Your platform integration, such as a Chat SDK state adapter |
| Agent session history and agent runtime capabilities                    | Flue                                                        |

Chat SDK's in-memory state adapter is useful for local development and examples. Use a persistent Chat SDK state adapter when subscriptions or chat-side coordination must survive restarts or multiple application instances. That choice does not configure persistence or durability for Flue agent processing.

Provider events and asynchronous processing can also be retried. If posting a duplicate reply or action would be harmful, make outbound tools idempotent using application-owned records or provider-supported idempotency behavior.

## Next steps

- Explore `examples/chat-sdk/` for a runnable GitHub mention-to-reply integration.
- See the [Chat SDK documentation](https://chat-sdk.dev/docs) for its supported platform adapters, event handlers, and state adapters.
- See [Agents](/docs/guide/building-agents/) for continuing agent instances and asynchronous `dispatch(...)` input.
- See [Routing](/docs/guide/routing/) for composing webhook routes with Flue application routes.
- See [Tools](/docs/guide/tools/) for controlling external side effects.
- See [Develop & Build](/docs/guide/develop-and-build/) for running the application and continuing to deployment.
