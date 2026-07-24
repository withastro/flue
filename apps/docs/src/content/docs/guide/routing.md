---
title: Routing
description: Mount agents, channels, and custom routes explicitly in app.ts.
lastReviewedAt: 2026-07-21
---

Flue never mounts an agent automatically. Registering an agent (the [`'use agent'` directive](/docs/guide/building-agents/#use-agent-directive)) makes it _addressable_ inside your application; serving it over HTTP is a separate, explicit decision that you make in your application's route map. This guide covers that route map — `app.ts` — mounting agents with `createAgentRouter(...)`, the URL surface each conversation gets, and how to protect it.

## `app.ts` is the route map

Every Flue application has one HTTP entrypoint: `src/app.ts`. Its default export is the server — every agent, channel, and custom route your application serves is mounted there explicitly. Flue does not generate routes from filenames or directory conventions: if a route exists, `app.ts` put it there. The scaffolded version is a complete application:

```ts title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Hello } from './agents/hello.ts';

const app = new Hono();

app.route('/agents/hello', createAgentRouter(Hello));

export default app;
```

The same `app.ts` works on both targets. On Node.js, the [built server](/docs/guide/node-target/) serves whatever it exports; on [Cloudflare](/docs/guide/cloudflare-target/), the same export becomes the Worker's fetch handler. See [Deploy](/docs/guide/deploy/).

Flue uses [Hono](https://hono.dev/) by convention, but nothing here is Hono-specific: the default export just needs a fetch-compatible shape, and the routers Flue gives you expose `.fetch` themselves, so they mount in any fetch-based framework. The `Fetchable` interface is available when you need to type a custom application entry:

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

Because it's a plain router, `app.ts` is also where the rest of your application's HTTP lives: health checks, webhook receivers that [`dispatch(...)`](/docs/guide/building-agents/#dispatch) into agents, static assets for a chat UI, and [channel](#mounting-a-channel) mounts all compose alongside your agent routes.

## Mounting an agent

`createAgentRouter(agent)` from `@flue/runtime/routing` builds the HTTP surface for one agent: a small sub-router you mount wherever you want it to live.

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

A few properties worth knowing:

- **The URL is yours.** `/agents/<name>` is a convention, not a requirement — mount under `/api`, behind a versioned prefix, anywhere. The mount path is pure routing, and clients address whatever URL you choose.
- **The mount path is not the agent's identity.** Conversations are keyed by the agent's durable identity — its function name, or an `agentName` static override — never by the URL. You can move a mount without a data migration, and mounting the same agent at two paths serves the same conversations from both.
- **It's a pure factory.** `createAgentRouter(...)` has no side effects and no options; call it any number of times, or never. Everything else about the agent — model, durability, initial-data schema — is declared on the agent module itself, not at the mount.
- **Mounting is the exposure decision, not registration.** The [`'use agent'` scan](/docs/guide/building-agents/#use-agent-directive) is what makes an agent exist; the router only builds an HTTP surface over an already-registered agent. An agent that is registered but never mounted is simply unreachable over HTTP — `dispatch(...)` and [schedules](/docs/guide/schedules/) can still drive it (see [Dispatch-only agents](#dispatch-only-agents) below).

## The conversation URL

Each conversation lives at the mount path plus a conversation id you choose: `/agents/support/ticket-8472`. The id is the same caller-chosen identifier described in the [Agents guide](/docs/guide/building-agents/) — a user id, a ticket number, any string — and the conversation is created on the first message it receives. Relative to the mount, the router serves:

| Route                                | Purpose                                                    |
| ------------------------------------ | ---------------------------------------------------------- |
| `POST /:id`                          | Deliver one message (`202` admission).                     |
| `GET /:id`                           | Read the conversation (snapshot, updates, or live stream). |
| `HEAD /:id`                          | Read conversation stream metadata.                         |
| `POST /:id/abort`                    | Abort in-flight and queued work.                           |
| `GET /:id/attachments/:attachmentId` | Download one attachment's bytes.                           |

### Sending a message

`POST` the message to the conversation URL. The body is the same `DeliveredMessage` shape a server-side `dispatch(...)` admits — a `user` chat turn or a structured `signal` — optionally alongside `initialData` for instance creation:

```http title="Prompt a support conversation"
POST /agents/support/ticket-8472 HTTP/1.1
Content-Type: application/json

{
  "kind": "user",
  "body": "Can you summarize the open issues in my case?"
}
```

Sends are **fire-and-forget**: the server responds `202` as soon as the message is durably admitted, before the agent runs. The response carries the coordinates for following the outcome — the conversation's stream URL, an opaque resume offset, and a submission id:

```json
{
  "streamUrl": "https://example.com/agents/support/ticket-8472",
  "offset": "-1",
  "submissionId": "sub_01HZX..."
}
```

There is no "wait for the reply" mode on this route. The agent's reply lands in the conversation, and you read it from there.

### Reading the conversation

`GET` the same URL to read the conversation. A plain `GET` returns one materialized snapshot — every message reduced to complete, render-ready parts. Query parameters select live modes: `?view=updates&offset=...` reads changes after an offset, with long-polling or server-sent events for continuous streaming. The wire protocol is documented in the [Streaming Protocol](/docs/reference/streaming-protocol/) reference, but you rarely consume it by hand, because the Flue Agent SDK wraps it.

### The SDK wraps this surface

A [`createFlueClient(...)`](/docs/sdk/create-flue-client/) client addresses exactly one conversation URL and packages the whole surface — `send()`, `wait()`, `observe()`, `history()`, `abort()`, and `attachmentUrl()` — over the routes above:

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

The client takes no agent name or deployment address — the URL is the whole contract, so the mount layout never leaks into client configuration. For chat UIs, [`useFlueAgent({ url })`](/docs/guide/react/) from `@flue/react` wraps the same client with maintained conversation state. Errors on every route share one machine-readable envelope; see the [Errors Reference](/docs/reference/errors/).

## Protecting your agents

A mounted agent has no built-in authentication: **anyone who can reach a conversation URL can talk to that conversation** — send it messages, read its full history, abort its work. There is no per-agent middleware export either. Treat a mount like any other sensitive endpoint and protect it with your application's normal middleware, layered in `app.ts` before the mount it applies to.

There are two checks, and production applications need both:

1. **Authentication** — who is the caller?
2. **Authorization** — is this caller allowed to access _this conversation id_?

Conversation ids are caller-chosen path segments: without an ownership check, any authenticated user can read another user's conversation by guessing its id.

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

Because the middleware pattern ends in `/*`, it covers every route the agent router serves — prompts, reads, aborts, and attachment downloads alike. This is ordinary Hono composition, so anything your framework supports works here: shared middleware over a broader prefix (`app.use('/agents/*', requireUser)`), bearer tokens, session cookies, signature verification, per-route rate limits.

Two related patterns:

- **Server-issued ids.** Instead of trusting caller-chosen ids, derive them from the authenticated principal (`user-${user.id}`) or issue them from your own database. The ownership check then becomes a simple equality test.
- **Private agents.** An agent that only your own backend should reach doesn't need a public mount at all — keep it dispatch-only (below), or on Cloudflare, reach a private Worker over a [service binding](/docs/guide/cloudflare-target/#calling-a-private-agent-over-a-service-binding).

## CORS

Cross-origin access is an application concern: the agent router sets no `Access-Control-*` headers of its own. In [local development](/docs/guide/node-target/#local-development), `vite dev` and `vite preview` apply permissive localhost CORS defaults so a separately served SPA works out of the box — which means a cross-origin setup that works locally can fail after deployment unless you configure CORS yourself.

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

Same-origin deployments — the common setup, where `app.ts` serves both the UI and the agent mounts — need no CORS configuration at all.

## Mounting a channel

Channel objects expose their own `.route()` factory — a separate API from the agent router, but the same kind of pure, mountable sub-router. It serves the provider's declared routes relative to the mount point:

```ts title="src/app.ts"
import { channel as slack } from './channels/slack.ts';

app.route('/channels/slack', slack.route());
// Slack's Events API endpoint is now POST /channels/slack/events
```

The channel package declares its route suffixes (`/events`, `/webhook`, `/interactions`, …); the mount point is yours. See [Channels](/docs/guide/channels/#mounting).

## Mounting a directory of agents

Per-route mounting keeps the route map explicit, but nothing stops you from generating it. Vite's `import.meta.glob` recovers directory-style mounting in userland — enumerate the agent modules and mount each exported agent:

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

The glob only enumerates the modules — each mount is as explicit as a hand-written one. Skip or filter the glob for agents that should stay dispatch-only.

## Dispatch-only agents

Registration comes from the `'use agent'` scan, so any registered agent can receive messages through server-side [`dispatch(...)`](/docs/guide/building-agents/#dispatch) — from a webhook route in `app.ts`, a [channel](/docs/guide/channels/), or a [schedule](/docs/guide/schedules/) — without ever being mounted. An internal agent that only reacts to application events has no reason to be reachable from outside:

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

The webhook route belongs to your application: it decides which requests are valid and which agent conversation receives the accepted message. Mounting and dispatching also compose: a support agent might be mounted for its chat UI _and_ receive webhook signals through `dispatch(...)` — both feed the same per-conversation queue. To observe a dispatch-only agent's conversations over HTTP (for example, an internal dashboard), add a mount behind admin-only middleware.

## Next steps

- [Agents](/docs/guide/building-agents/) — every way to interact with an agent: CLI, HTTP, `dispatch()`, and standalone scripts.
- [Agent SDK](/docs/sdk/overview/) — the client that wraps a conversation URL.
- [React](/docs/guide/react/) — build a chat UI on a mounted agent.
- [Channels](/docs/guide/channels/) — verified provider webhooks that deliver events into agents.
- [Streaming Protocol](/docs/reference/streaming-protocol/) — the wire protocol behind conversation reads.
- [Deploy](/docs/guide/deploy/) — build `app.ts` and your agents into a deployable server.
