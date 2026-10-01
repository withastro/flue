---
title: Routing
description: Mount agents, channels, and custom routes explicitly in app.ts.
lastReviewedAt: 2026-07-21
---

Flue never mounts an agent automatically. Registering an agent (the [`'use agent'` directive](/docs/guide/building-agents/#use-agent-directive)) makes it _addressable_ inside your application. Serving it over HTTP is a separate, explicit decision that you make in your application's route map. This guide covers that route map (`app.ts`), mounting agents with `createAgentRouter(...)`, the routes each conversation gets, and how to protect them.

## `app.ts` is the route map

Every Flue application has one HTTP entrypoint, `src/app.ts`. Its default export is the server, and every agent, channel, and custom route your application serves is mounted there explicitly. Flue does not generate routes from filenames or directory conventions. If a route exists, `app.ts` put it there. The scaffolded version is a complete application:

```ts title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';

const app = new Hono();

app.route('/agents/hello', createAgentRouter(Hello));

export default app;
```

The same `app.ts` works on both targets. On Node.js, the [built server](/docs/guide/node-target/) serves whatever it exports. On [Cloudflare](/docs/guide/cloudflare-target/), the same export becomes the Worker's fetch handler. See [Deploy](/docs/guide/deploy/).

Flue uses [Hono](https://hono.dev/) by convention, but nothing here is Hono-specific. The default export needs only a fetch-compatible interface, and the routers Flue gives you expose `.fetch` themselves, so they mount in any fetch-based framework. The `Fetchable` interface is available when you need to type a custom application entry:

```ts
import type { Fetchable } from '@flue/runtime/routing';

const app: Fetchable = {
  fetch(request, env, ctx) {
    return new Response('Not found', { status: 404 });
  },
};

export default app;
```

A Hono application already satisfies this interface. On Cloudflare, `env` contains bindings and `ctx` is the execution context. On Node.js, `env` contains the Hono Node adapter bindings and `ctx` is `undefined`.

Because it's a plain router, `app.ts` is also where the rest of your application's HTTP lives. Health checks, webhook receivers that [`dispatch(...)`](/docs/guide/building-agents/#dispatch) into agents, static assets for a chat UI, and [channel](#mounting-a-channel) mounts all compose alongside your agent routes.

## Mounting an agent

`createAgentRouter(agent)` from `@flue/runtime/routing` builds the HTTP routes for one agent as a small sub-router that you mount wherever you want.

```ts title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';
import { Triage } from './agents/triage.ts';

const app = new Hono();

app.route('/agents/support', createAgentRouter(Support));
app.route('/api/assistants/triage', createAgentRouter(Triage));

export default app;
```

Mounts have these properties:

- **The URL is yours.** `/agents/<name>` is a convention. You can mount under `/api`, behind a versioned prefix, or anywhere else. The mount path only affects routing, and clients address whatever URL you choose.
- **The mount path is not the agent's identity.** Conversations are keyed by the agent's durable identity (its function name, or an `agentName` static override), never by the URL. You can move a mount without a data migration, and mounting the same agent at two paths serves the same conversations from both.
- **It's a pure factory.** `createAgentRouter(...)` has no side effects and takes no options. Call it any number of times, or never. Everything else about the agent (model, durability, initial-data schema) is declared on the agent module itself.
- **Mounting decides exposure, not registration.** The [`'use agent'` scan](/docs/guide/building-agents/#use-agent-directive) registers an agent. The router only builds HTTP routes for an agent that is already registered. An agent that is registered but never mounted is unreachable over HTTP, but `dispatch(...)` and [schedules](/docs/guide/schedules/) can still drive it (see [Dispatch-only agents](#dispatch-only-agents) below).

## The conversation URL

Each conversation lives at the mount path plus a conversation id you choose, as in `/agents/support/ticket-8472`. The id is the same caller-chosen identifier described in the [Agents guide](/docs/guide/building-agents/), such as a user id, a ticket number, or any other string. Flue creates the conversation on the first message it receives. Relative to the mount, the router serves:

| Route                                | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `POST /:id`                          | Deliver one message (`202` admission).                     |
| `GET /:id`                           | Read the conversation (snapshot, updates, or live stream). |
| `HEAD /:id`                          | Read conversation stream metadata.                         |
| `POST /:id/abort`                    | Abort in-flight and queued work.                           |
| `GET /:id/attachments/:attachmentId` | Download one attachment's bytes.                           |

### Sending a message

`POST` the message to the conversation URL. The body is the same `DeliveredMessage` a server-side `dispatch(...)` admits (a `user` chat turn or a structured `signal`), optionally with `initialData` for instance creation:

```http title="Prompt a support conversation"
POST /agents/support/ticket-8472 HTTP/1.1
Content-Type: application/json

{
  "kind": "user",
  "body": "Can you summarize the open issues in my case?"
}
```

Sends are fire-and-forget. The server responds `202` as soon as the message is durably admitted, before the agent runs. So you can follow the outcome, the response carries the conversation's stream URL, an opaque resume offset, and a submission id:

```json
{
  "streamUrl": "https://example.com/agents/support/ticket-8472",
  "offset": "-1",
  "submissionId": "sub_01HZX..."
}
```

There is no "wait for the reply" mode on this route. The agent's reply lands in the conversation, and you read it from there.

### Reading the conversation

`GET` the same URL to read the conversation. A plain `GET` returns one materialized snapshot, with every message reduced to complete, render-ready parts. Query parameters select live modes. For example, `?view=updates&offset=...` reads changes after an offset, with long-polling or server-sent events for continuous streaming. The wire protocol is documented in the [Streaming Protocol](/docs/reference/streaming-protocol/) reference, but you rarely consume it by hand, because the Flue Agent SDK wraps it.

### The SDK wraps this surface

A [`createFlueClient(...)`](/docs/sdk/create-flue-client/) client addresses one conversation URL and wraps the routes above in `send()`, `wait()`, `observe()`, `history()`, `abort()`, and `attachmentUrl()`:

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/support/ticket-8472',
  token: userToken,
});

const admission = await conversation.send({
  message: { kind: 'user', body: 'Can you summarize the open issues in my case?' },
});
await conversation.wait(admission);
const { messages } = await conversation.history();
```

The client takes no agent name or deployment address. It needs only the URL, so the mount layout never leaks into client configuration. For chat UIs, [`useFlueAgent({ url })`](/docs/guide/react/) from `@flue/react` wraps the same client with maintained conversation state. Errors on every route share one machine-readable envelope. See the [Errors Reference](/docs/reference/errors/).

## Protecting your agents

A mounted agent has no built-in authentication. **Anyone who can reach a conversation URL can send it messages, read its full history, and abort its work.** Flue has no per-agent middleware export either. Treat a mount like any other sensitive endpoint and protect it with your application's normal middleware, layered in `app.ts` before the mount it applies to.

There are two checks, and production applications need both:

1. **Authentication** — who is the caller?
2. **Authorization** — is this caller allowed to access _this conversation id_?

Conversation ids are caller-chosen path segments. Without an ownership check, any authenticated user can read another user's conversation by guessing its id.

```ts title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Support } from './agents/support.ts';
import { canAccessTicket, verifySession } from './shared/auth.ts';

const app = new Hono();

app.use('/agents/support/*', async (c, next) => {
  const user = await verifySession(c.req.raw); // your application's auth
  if (!user) return c.json({ error: 'unauthorized' }, 401);

  // The conversation id is the first path segment after the mount.
  const [conversationId] = c.req.path.slice('/agents/support/'.length).split('/');
  if (!(await canAccessTicket(user, conversationId))) {
    return c.json({ error: 'forbidden' }, 403);
  }
  return next();
});
app.route('/agents/support', createAgentRouter(Support));

export default app;
```

Because the middleware pattern ends in `/*`, it covers every route the agent router serves, so prompts, reads, aborts, and attachment downloads all pass through it. This is ordinary Hono composition, so anything your framework supports works here. Examples are shared middleware over a broader prefix (`app.use('/agents/*', requireUser)`), bearer tokens, session cookies, signature verification, and per-route rate limits.

Two related patterns:

- **Server-issued ids.** Instead of trusting caller-chosen ids, derive them from the authenticated principal (`user-${user.id}`) or issue them from your own database. The ownership check then becomes an equality test.
- **Private agents.** An agent that only your own backend should reach doesn't need a public mount. Keep it dispatch-only (below), or on Cloudflare, reach a private Worker over a [service binding](/docs/guide/cloudflare-target/#calling-a-private-agent-over-a-service-binding).

## CORS

Cross-origin access is an application concern. The agent router sets no `Access-Control-*` headers of its own. In [local development](/docs/guide/node-target/#local-development), `vite dev` and `vite preview` apply permissive localhost CORS defaults so a separately served SPA works without extra setup. As a result, a cross-origin setup that works locally can fail after deployment unless you configure CORS yourself.

If browsers on another origin call your agents in production, add your framework's CORS middleware in `app.ts`. Expose the stream coordination headers so the SDK can resume conversation streams across reconnects:

```ts title="src/app.ts"
import { cors } from 'hono/cors';

app.use(
  '/agents/*',
  cors({
    origin: 'https://app.example.com',
    credentials: true,
    exposeHeaders: ['Stream-Next-Offset', 'Stream-Up-To-Date', 'Location'],
  }),
);
```

Same-origin deployments, the common setup where `app.ts` serves both the UI and the agent mounts, need no CORS configuration.

## Mounting a channel

Channel objects expose their own `.route()` factory. It is a separate API from the agent router, but it returns the same kind of pure, mountable sub-router. It serves the provider's declared routes relative to the mount point:

```ts title="src/app.ts"
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
// Slack's Events API endpoint is now POST /channels/slack/events
```

The channel package declares its route suffixes (`/events`, `/webhook`, `/interactions`, …), and you choose the mount point. See [Channels](/docs/guide/channels/#mounting).

## Mounting a directory of agents

Per-route mounting keeps the route map explicit, but nothing stops you from generating it. Vite's `import.meta.glob` gives you directory-style mounting in userland. Enumerate the agent modules and mount each exported agent:

```ts title="src/app.ts"
import type { Agent } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';

const app = new Hono();

const modules = import.meta.glob<Record<string, Agent>>('./agents/*.ts', { eager: true });
for (const mod of Object.values(modules)) {
  for (const [exportName, agent] of Object.entries(mod)) {
    if (typeof agent !== 'function' || !/^[A-Z]/.test(exportName)) continue; // agents are the capitalized exports
    app.route(`/agents/${agent.agentName ?? exportName}`, createAgentRouter(agent));
  }
}

export default app;
```

The glob only enumerates the modules. Each mount is as explicit as a hand-written one. Skip or filter the glob for agents that should stay dispatch-only.

## Dispatch-only agents

Registration comes from the `'use agent'` scan, so any registered agent can receive messages through server-side [`dispatch(...)`](/docs/guide/building-agents/#dispatch) without being mounted. The dispatch can come from a webhook route in `app.ts`, a [channel](/docs/guide/channels/), or a [schedule](/docs/guide/schedules/). An internal agent that only reacts to application events has no reason to be reachable from outside:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import { InvoiceAuditor } from './agents/invoice-auditor.ts';
import { verifyBillingWebhook } from './shared/billing.ts';

const app = new Hono();

// No createAgentRouter(InvoiceAuditor) mount anywhere — the agent is
// registered, but only this verified webhook can reach it.
app.post('/webhooks/billing', async (c) => {
  const event = await verifyBillingWebhook(c.req.raw);
  const receipt = await dispatch(InvoiceAuditor, {
    id: event.invoiceId,
    message: {
      kind: 'signal',
      type: 'billing.invoice.flagged',
      body: event.summary,
    },
  });
  return c.json(receipt, 202);
});

export default app;
```

The webhook route belongs to your application. It decides which requests are valid and which agent conversation receives the accepted message. Mounting and dispatching also compose. A support agent might be mounted for its chat UI _and_ receive webhook signals through `dispatch(...)`, and both feed the same per-conversation queue. To observe a dispatch-only agent's conversations over HTTP (for example, an internal dashboard), add a mount behind admin-only middleware.

## Next steps

- [Agents](/docs/guide/building-agents/) — every way to interact with an agent, through the CLI, HTTP, `dispatch()`, or standalone scripts.
- [Agent SDK](/docs/sdk/overview/) — the client that wraps a conversation URL.
- [React](/docs/guide/react/) — build a chat UI on a mounted agent.
- [Channels](/docs/guide/channels/) — verified provider webhooks that deliver events into agents.
- [Streaming Protocol](/docs/reference/streaming-protocol/) — the wire protocol behind conversation reads.
- [Deploy](/docs/guide/deploy/) — build `app.ts` and your agents into a deployable server.
