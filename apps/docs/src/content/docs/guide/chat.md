---
title: Chat
description: Combine Chat SDK platform adapters with Flue agents for two-way conversational integrations.
---

Chat platforms are more than webhook sources: a useful assistant may need to recognize mentions, continue a thread, post formatted replies, react to messages, or use provider-specific interactions. [Chat SDK](https://chat-sdk.dev/docs) provides these chat-facing capabilities across supported platforms, while Flue provides addressable agents, continuing sessions, tools, and asynchronous execution.

For most two-way chat integrations, Chat SDK is a natural companion to Flue. It is not required: an [authored channel](/guide/channels/) or a custom application route can be a better fit for provider events that do not need conversational semantics or for integrations requiring complete control of the provider API surface.

## Architecture

A Chat SDK integration typically places the platform boundary in application code and dispatches normalized conversational input to a Flue agent:

```txt
platform webhook
  → Chat SDK adapter
  → dispatch(agent, ...)
  → continuing Flue agent session
  → explicit Chat SDK-backed tool
  → platform reply, edit, reaction, or native action
```

This separation keeps platform protocols and conversational behavior out of the agent runtime, without hiding outbound side effects from the agent application.

| Concern | Owner |
| --- | --- |
| Webhook parsing and verification | Chat SDK adapter |
| Normalized threads, messages, and platform actions | Chat SDK |
| Thread subscriptions, message overlap, and chat-facing state | Chat SDK state adapter |
| Selecting an agent instance and session | Your Flue application |
| Accepting asynchronous agent input | Flue `dispatch(...)` |
| Model execution, tools, sandboxes, and session history | Flue agent |
| Replies and other external side effects | Explicit tools using Chat SDK or native provider clients |

The repository includes a verified GitHub issue-comment integration in `examples/chat-sdk/`. The same boundary applies to platforms such as Slack, Microsoft Teams, Google Chat, Discord, Telegram, WhatsApp, Messenger, Linear, and GitHub, subject to each adapter's supported features and deployment requirements.

## What Chat SDK contributes

Chat SDK gives an application a shared model for common chat behavior while preserving access to provider-specific functionality. In a Flue application, the most relevant capabilities are:

- **Platform adapters** that receive provider webhooks and make outbound provider calls.
- **Threads and messages** normalized across supported providers, so routing logic can operate on stable conversational identities.
- **Event handlers** for mentions, subscribed messages, reactions, slash commands, actions, modals, and provider-specific events where supported.
- **Subscriptions** that let a bot begin with a mention and continue receiving later messages in the same thread.
- **Outbound messaging** including posts, formatting, edits, reactions, cards, files, and streaming where supported by the adapter.
- **Concurrency and state** for deduplication, locking, queued or collapsed overlapping messages, thread state, and subscriptions.
- **Native client access** when a provider feature is outside the normalized API.

Flue does not need to introduce a universal `reply()` abstraction to use these capabilities. Instead, an agent receives only the context it needs and is given explicit tools for allowed outbound actions.

## Keep the bot at the application boundary

A shared bot module can own adapter configuration and inbound chat routing. For a project using the `.flue/` source layout, this module belongs alongside `app.ts` rather than inside an agent definition:

```ts title=".flue/chat.ts"
import { createGitHubAdapter } from '@chat-adapter/github';
import { createRedisState } from '@chat-adapter/state-redis';
import { dispatch, type CreatedAgent } from '@flue/runtime';
import { Chat } from 'chat';

export const bot = new Chat({
  userName: 'support-bot',
  adapters: {
    github: createGitHubAdapter(),
  },
  state: createRedisState(),
  concurrency: 'queue',
});

export function registerChatHandlers(agent: CreatedAgent) {
  bot.onNewMention(async (thread, message) => {
    await thread.subscribe();
    await dispatchChatMessage(agent, thread.id, message.id, message.text);
  });

  bot.onSubscribedMessage(async (thread, message) => {
    await dispatchChatMessage(agent, thread.id, message.id, message.text);
  });
}

async function dispatchChatMessage(agent: CreatedAgent, threadId: string, messageId: string, text: string) {
  await dispatch(agent, {
    id: threadId,
    session: threadId,
    input: { type: 'chat.message', messageId, text },
  });
}
```

This pattern makes two boundaries explicit:

- Chat SDK decides which provider messages enter a conversation. For example, `thread.subscribe()` makes later messages eligible for `onSubscribedMessage(...)`.
- Flue decides where accepted input is processed. Here, the normalized `thread.id` is used for both the agent instance and session so one chat thread maps to one continuing agent conversation.

Import `dispatch` from `@flue/runtime` and prefer `dispatch(agent, ...)` when the created agent is available. Reference-based dispatch follows the default-exported agent module if it is renamed, instead of embedding an agent name string in routing code.

## Mount provider ingress in the application

A custom `app.ts` composes Chat SDK webhook routes with the Flue application. The bot remains ordinary application-owned integration code; it does not need to be modeled as an authored channel:

```ts title=".flue/app.ts"
import { flue } from '@flue/runtime/app';
import { Hono } from 'hono';
import assistant from './agents/assistant.ts';
import { bot, registerChatHandlers } from './chat.ts';

registerChatHandlers(assistant);

const app = new Hono();

app.post('/webhooks/github', (c) => bot.webhooks.github(c.req.raw));
app.route('/', flue());

export default app;
```

The mounted adapter owns validation and interpretation of provider webhook requests. The handler then selects what to dispatch and what input the agent should see; avoid passing unnecessary raw webhook payloads into a model-visible conversation.

On runtimes with background request lifecycles, pass the relevant lifecycle facility to Chat SDK when required. For example, the Cloudflare fixture in `examples/chat-sdk/.flue/app.ts` supplies `executionCtx.waitUntil(...)` to its webhook handler so asynchronous adapter work is attached to the Worker request lifecycle.

## Route chat identity into Flue sessions

Chat SDK threads are a useful default identity boundary for conversational agents:

```ts
await dispatch(assistant, {
  id: thread.id,
  session: thread.id,
  input: {
    type: 'chat.message',
    messageId: message.id,
    text: message.text,
  },
});
```

`id` selects the agent instance and `session` selects conversation history within that instance. Mapping both to the chat thread gives the agent a continuing context for that thread and allows its outbound tools to be scoped to the instance identity rather than trusting a model-supplied destination. Applications with a broader tenant or workspace boundary may instead use an account, repository, or team as `id`, while retaining the thread as `session`; in that design, enforce the allowed outbound thread in application-owned state before posting.

`dispatch(...)` accepts the message for asynchronous agent processing. Its receipt contains a `dispatchId` and `acceptedAt`; it does not wait for the agent to post a reply. A dispatched chat message is an operation in an agent session, not a workflow run, and is not inspected through workflow run history or `flue logs`.

## Make outbound actions explicit tools

An inbound chat message does not imply that every agent response should be sent back to the provider. A tool gives the agent a controlled, observable capability for posting into the originating thread:

```ts title=".flue/agents/assistant.ts"
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

Because this routing model uses the Chat SDK thread ID as the Flue instance `id`, the tool closes over its dispatched destination and lets the model choose only the reply content. Expose this outbound-capable agent only through authenticated application routes that prevent callers from selecting an unauthorized instance ID; a public direct prompt route could otherwise target another thread. Apply the same principle to tools for reactions, edits, cards, files, or native provider actions. If an instance covers multiple provider threads, look up and validate the allowed destination in application-owned state rather than taking it directly from model input. This makes permissions and external side effects a deliberate part of agent design rather than an implicit transport behavior.

## Two kinds of conversational state

A two-way integration has related but distinct state concerns:

| State | Purpose | Owned by |
| --- | --- | --- |
| Thread subscription | Whether later provider messages should be handled | Chat SDK state adapter |
| Dedupe, locks, queues, and adapter cache | Safe coordination of webhook-driven chat behavior | Chat SDK state adapter |
| Agent session history | Context available to the model and its tools | Flue |
| Sandbox or agent resources | Stateful runtime capabilities selected by agent instance | Flue |

The in-memory Chat SDK state adapter is useful for examples and local development. A production integration should use a persistent adapter, such as a supported Redis or PostgreSQL adapter, so subscriptions and chat-side coordination survive restarts and work across concurrent application instances. This does not configure Flue session persistence or dispatch durability.

Chat SDK concurrency governs inbound handler overlap. In the asynchronous pattern above, a handler finishes once `dispatch(...)` accepts its input, before Flue completes model or tool work; `concurrency: 'queue'` therefore does not serialize pending agent replies. Queue, burst, or debounce strategies are still useful when you intentionally aggregate overlapping inbound messages before one dispatch, including `context.skipped` messages where appropriate.

## Production considerations

### Protect outbound side effects

Provider webhooks may be retried, and asynchronous processing can be retried after interruption. If duplicate replies, reactions, or provider mutations would be harmful, design tools with an idempotency key or persisted record of completed outbound actions. Useful inputs include the source provider message ID and Flue `dispatchId`.

### Keep credentials at the adapter boundary

Configure adapter credentials and webhook secrets through deployment secrets or environment variables. Chat SDK adapters can read provider-specific environment variables, while `app.ts` and the bot module remain the appropriate place to configure which adapters are active.

### Understand target-specific durability

Persistent Chat SDK state covers subscriptions, dedupe, locks, queues, and adapter state; it does not make Flue processing restart-safe by itself. On the Node target, `dispatch(...)` currently uses process-memory admission, so accepted chat input can be lost on restart; use the Cloudflare durable path or application-managed durable delivery when restart-safe asynchronous chat processing is required. Configure session persistence separately if Node agent history must survive restarts. On the Cloudflare target, agent processing uses its Durable Object-backed runtime path, but outbound provider actions still need idempotency protection.

### Validate platform and target combinations

Chat SDK offers adapters for platforms with different interaction and transport modes. Webhook-based GitHub message handling has been verified in `examples/chat-sdk/` on local Node and Cloudflare targets. Long-lived connection modes and provider-specific authentication or native SDK requirements should be validated for the deployment target you intend to use.

### Correlate work using agent identifiers

Use `dispatchId`, agent instance identity, session identity, and operation events to observe chat-triggered agent processing. Work dispatched from Chat SDK handlers does not create workflow `runId` values; use Flue observation integrations rather than workflow-run tooling for this traffic.

## Chat SDK, authored channels, or direct routes?

These integration surfaces are complementary:

| Integration need | Good starting point |
| --- | --- |
| Two-way conversational assistant across supported chat platforms | Chat SDK with Flue agents |
| Provider thread assistant that posts replies or actions, such as GitHub issue discussions | Chat SDK with Flue agents |
| Typed inbound provider events without conversational output | Authored Flue channel |
| Bespoke webhook handling or provider behavior not represented by a shared abstraction | Custom route with the provider SDK |
| Finite, result-oriented automation initiated by application logic | Flue workflow |

Chat SDK is a strong default when the core user experience is a conversation. Authored channels and direct routes remain appropriate when an integration is primarily event-driven, provider-specific, or deliberately does not expose conversational actions to an agent.

See `examples/chat-sdk/` for the runnable GitHub integration pattern and the Chat SDK documentation for current platform capabilities and state adapter options.
