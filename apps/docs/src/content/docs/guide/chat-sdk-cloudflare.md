---
title: Durable Chat SDK on Cloudflare
description: Use Durable Object-backed Chat SDK state with Flue agents on the Cloudflare target.
lastReviewedAt: 2026-06-10
---

Chat SDK works anywhere your app can receive webhooks and keep Chat SDK state. Use this Cloudflare setup when you want Chat SDK's chat-side state backed by Durable Objects while Flue owns agent execution.

## Install the optional packages

The Chat SDK integration is optional. Add the packages used by your application:

```bash
pnpm add chat agents @chat-adapter/github
```

Use the adapter package for the platform you are integrating. The examples below use GitHub issue comments because they can be exercised locally without a Slack or Discord workspace.

## Create a chat ingress Durable Object

Put Chat SDK webhook handling in an authored Cloudflare entrypoint. Create `src/cloudflare.ts`, export the Chat SDK state agent, and create a Durable Object that owns the Chat SDK `Chat` instance:

```ts title="src/cloudflare.ts"
import { createGitHubAdapter } from "@chat-adapter/github";
import { dispatch } from "@flue/runtime";
import { Agent } from "agents";
import { ChatSdkStateAgent, createChatSdkState } from "agents/chat-sdk";
import { Chat } from "chat";
import assistant from "./agents/assistant.ts";

class FlueChatSdkStateAgent extends ChatSdkStateAgent {}

export { FlueChatSdkStateAgent };

export class ChatIngressAgent extends Agent<Env> {
  private channel?: ReturnType<typeof this.createChannel>;

  onStart() {
    this.channel = this.createChannel();
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/webhooks/github") {
      return this.channel!.bot.webhooks.github(request, {
        waitUntil: (task) => this.ctx.waitUntil(task),
      });
    }

    if (request.method === "POST" && url.pathname === "/deliver") {
      const { text, threadId } = await request.json<{ text: string; threadId: string }>();
      await this.channel!.bot.thread(threadId).post(text);
      return Response.json({ ok: true });
    }

    return new Response("Not found", { status: 404 });
  }

  private createChannel() {
    const bot = new Chat({
      userName: "support-bot",
      adapters: {
        github: createGitHubAdapter({
          token: this.env.GITHUB_TOKEN,
          userName: "support-bot",
          webhookSecret: this.env.GITHUB_WEBHOOK_SECRET,
        }),
      },
      concurrency: "queue",
      state: createChatSdkState({ agent: FlueChatSdkStateAgent }),
    });

    bot.onNewMention(async (thread, message, context) => {
      await thread.subscribe();
      await thread.startTyping?.();
      const event = { kind: "new_mention" as const, thread, message, context };
      await thread.setState({ _flue: { id: thread.id } });
      await dispatch(assistant, { id: thread.id, input: toAgentInput(event) });
    });

    bot.onSubscribedMessage(async (thread, message, context) => {
      await thread.startTyping?.();
      const event = { kind: "subscribed_message" as const, thread, message, context };
      const state = await thread.state as { _flue?: { id: string } } | undefined;
      await dispatch(assistant, { id: state?._flue?.id ?? thread.id, input: toAgentInput(event) });
    });

    bot.onAction(async (action) => {
      const event = { kind: "action" as const, action, thread: action.thread };
      const state = action.thread
        ? await action.thread.state as { _flue?: { id: string } } | undefined
        : undefined;
      await dispatch(assistant, { id: state?._flue?.id ?? action.threadId, input: toAgentInput(event) });
    });

    return { bot };
  }
}

type Env = {
  GITHUB_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
};

function toAgentInput(event: any): Record<string, unknown> {
  if (event.kind === "action") {
    return {
      type: "chat.action",
      actionId: event.action.actionId,
      threadId: event.action.threadId,
      value: event.action.value,
    };
  }

  return {
    type: "chat.message",
    kind: event.kind,
    messageId: event.message.id,
    text: event.message.text,
    threadId: event.thread.id,
    userId: event.message.author.userId,
  };
}
```

`createChatSdkState()` must be created inside an Agents SDK `Agent` context. The `ChatIngressAgent` provides that parent context, and `FlueChatSdkStateAgent` is used as a sub-agent for Chat SDK's subscription, lock, queue, and cache state.

## Forward the webhook route

Your application route should verify only the HTTP shape it owns, then forward the platform request to the ingress Durable Object. Chat SDK performs provider-specific verification through its adapter configuration.

```ts title="src/app.ts"
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

type Env = {
  CHAT_INGRESS: DurableObjectNamespace;
};

const app = new Hono<{ Bindings: Env }>();

app.post("/webhooks/github", (c) => {
  const namespace = c.env.CHAT_INGRESS;
  const stub = namespace.get(namespace.idFromName("default"));
  return stub.fetch(c.req.raw);
});

app.route("/", flue());

export default app;
```

The webhook provider still calls your application URL. The application decides which Durable Object owns chat ingress, and your Chat SDK event handlers decide which Flue agent instance receives each accepted event.

## Reply through a tool

Receiving a chat event does not automatically post a chat response. Give the agent an explicit tool that sends through the ingress Durable Object:

```ts title="src/agents/assistant.ts"
import { Type, createAgent, defineTool } from "@flue/runtime";

type Env = {
  CHAT_INGRESS: DurableObjectNamespace;
};

export default createAgent<unknown, Env>(({ env }) => ({
  model: "anthropic/claude-haiku-4-5",
  instructions: "Help in the chat thread and ask for approval before taking external action.",
  tools: [
    defineTool({
      name: "reply_to_chat_thread",
      description: "Post a response into the originating chat thread.",
      parameters: Type.Object({
        threadId: Type.String(),
        text: Type.String(),
      }),
      execute: async ({ threadId, text }) => {
        const namespace = env.CHAT_INGRESS;
        const stub = namespace.get(namespace.idFromName("default"));

        await stub.fetch(
          new Request("https://chat-ingress.local/deliver", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ threadId, text }),
          }),
        );

        return "Reply sent.";
      },
    }),
  ],
}));
```

## Configure Wrangler

Add the authored ingress Durable Object binding and migration to `wrangler.jsonc`:

```jsonc title="wrangler.jsonc"
{
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [
      {
        "name": "CHAT_INGRESS",
        "class_name": "ChatIngressAgent",
      },
      {
        "name": "FLUE_CHAT_SDK_STATE_AGENT",
        "class_name": "FlueChatSdkStateAgent",
      },
    ],
  },
  "migrations": [
    {
      "tag": "chat-ingress-agent",
      "new_sqlite_classes": ["ChatIngressAgent"],
    },
    {
      "tag": "chat-sdk-state-agent",
      "new_sqlite_classes": ["FlueChatSdkStateAgent"],
    },
  ],
}
```

Keep the Flue-generated Durable Object classes in your migration history as described in [Cloudflare Target](/docs/guide/targets/cloudflare/#wranglerjsonc). `FlueChatSdkStateAgent` must also be exported, bound, and migrated so the Agents SDK can resolve it through Cloudflare's Worker exports when creating Chat SDK state sub-agents.

## Run locally

Start the Cloudflare development target:

```bash
pnpm exec flue dev --target cloudflare
```

Expose the local Worker to a provider with a tunnel when the provider needs a public webhook URL. Use the public URL for `/webhooks/github`, `/slack/events`, or the platform route you mounted.

The runnable fixture in `examples/chat-sdk/` uses the same shape with a fake local GitHub API and a scripted model provider. It demonstrates a mention, a human approval reply in the same thread, and an approved outbound post.
