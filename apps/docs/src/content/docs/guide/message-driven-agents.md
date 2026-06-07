---
title: Message-Driven Agents
description: Deliver direct prompts and asynchronous application-owned inputs to continuing agent instances.
---

Flue has two execution products:

- **Workflows return results.** Use workflows for finite request/result jobs.
- **Agents receive messages.** Use agents for addressable instances that may receive many inputs over time.

This guide covers message-driven agents, direct attached surfaces, and application-owned ingress that asynchronously dispatches input. Flue does not automatically post replies, reactions, cards, or issue comments after an agent processes an input. Outward effects should happen through explicit tools.

## Agent model

An agent is a module in the selected source directory's `agents/` directory. New projects should use `src/agents/`; see [Project Layout](/docs/guide/project-layout/) for supported alternatives.

The important runtime concepts are:

- **Agent module:** source file such as `src/agents/moderator.ts`.
- **Agent profile:** reusable behavior created with `defineAgentProfile(...)`.
- **Created agent:** runtime initializer created with `createAgent(...)`.
- **Agent instance:** addressable continuing actor identified by `{ agentName, instanceId }`. Session durability depends on the configured [persistence](/docs/api/data-persistence-api/).
- **Session:** isolated conversation and context stream inside one instance.
- **Dispatched input:** one structured input accepted for a target agent instance and session.

Agent modules default-export `createAgent(...)` so the runtime can initialize an instance when messages arrive. Application routes and integration handlers may call `dispatch(...)` for asynchronous delivery to an agent session.

## Direct attached surfaces

Direct attached surfaces already know the target agent instance. HTTP and WebSocket delivery use the same resource path:

```txt
POST /agents/:name/:id
GET  /agents/:name/:id  (Upgrade: websocket)
```

The HTTP prompt payload is:

```json
{
  "message": "Summarize the current issue",
  "session": "default"
}
```

If `session` is omitted, Flue uses the `default` session.

Direct delivery:

- targets one explicit agent module and instance id;
- initializes the instance through its default `createAgent(...)` export;
- bypasses application-owned asynchronous ingress logic;
- bypasses `dispatch(...)`;
- can stream runtime events with HTTP `Accept: text/event-stream` or a WebSocket connection.

Direct agent prompts are attached session interactions. They do not allocate or return a `runId`, emit workflow `run_start` or `run_end`, or appear in `/runs` and `flue logs`.

Agent WebSockets are long-lived: a single connection may issue sequential prompts, each optionally selecting a named session. Prompt frames are correlated by transport `requestId` and selected instance and session, not by a run identifier. Workflows may also export `websocket` middleware, but a workflow socket accepts exactly one invocation and closes after its terminal result because it represents one finite workflow run.

Declare direct public exposure with exported Hono middleware. `route` enables HTTP and `websocket` enables WebSocket access; either middleware may authenticate the request before calling `next()`.

```ts
import {
  createAgent,
  defineAgentProfile,
  type AgentRouteHandler,
  type AgentWebSocketHandler,
} from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();
export const websocket: AgentWebSocketHandler = async (_c, next) => next();

const assistant = defineAgentProfile({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'You are a helpful direct chat assistant.',
});

export default createAgent(({ id }) => ({
  profile: assistant,
  cwd: `/accounts/${id}`,
}));
```

Example request:

```bash
curl http://localhost:3583/agents/assistant/user-123 \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","session":"thread:1"}'
```

Example socket client:

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: 'http://localhost:3583' });
const socket = client.agents.connect('assistant', 'user-123');
await socket.ready;
socket.onEvent((event) => console.log(event));
await socket.prompt('Hello', { session: 'thread:1' });
await socket.prompt('Continue', { session: 'thread:1' });
socket.close();
```

## Application-owned ingress

Use a custom `app.ts` or integration module for provider webhooks and other event sources. Application code owns authentication, payload parsing, provider-specific behavior, and selection of the target agent instance and session before calling `dispatch(...)`.

```ts
import { Hono } from 'hono';
import { flue } from '@flue/runtime/routing';
import { dispatch } from '@flue/runtime';
import triage from './agents/triage.ts';

const app = new Hono();

app.post('/webhooks/github', async (c) => {
  const event = await verifyAndParseGitHubWebhook(c.req.raw);
  const repository = event.payload.repository?.full_name;
  const issue = event.payload.issue?.number;
  if (typeof repository !== 'string' || typeof issue !== 'number')
    return c.json({ accepted: false }, 202);

  const receipt = await dispatch(triage, {
    id: `repo:${repository}`,
    session: `issue:${issue}`,
    input: { type: 'github.issue', deliveryId: event.deliveryId },
  });
  return c.json(receipt, 202);
});

app.route('/', flue());
export default app;
```

Application-owned ingress:

- may ignore, transform, or explicitly `dispatch(...)` accepted work;
- can acknowledge webhook admission before model processing completes;
- does not imply an outbound provider action.

## `dispatch(...)`

Use `dispatch(...)` from application logic to admit structured input into an agent session:

```ts
const receipt = await dispatch({
  agent: 'audit',
  id: 'account:acme',
  session: 'event:github-delivery-123',
  input: {
    type: 'audit.external_delivery_observed',
    deliveryId: delivery.id,
  },
});

console.log(receipt.dispatchId);
```

Fields:

- `agent`: target agent module name in the named overload; use `dispatch(createdAgent, request)` when a created-agent reference is available.
- `id`: target agent instance id.
- `session`: target session name; defaults to `default`. Names beginning with `task:` are reserved for framework-owned delegated tasks.
- `input`: JSON-like structured payload.

`await dispatch(...)` means the input was accepted and queued for the target session according to the current runtime's guarantees. It does not mean the model finished processing, produced a reply, or completed tool calls. The returned `dispatchId` identifies asynchronous delivery and any delivery recovery or idempotency behavior; it is not a run ID.

On Cloudflare, direct prompts and dispatched input enter the same durable per-session order. Flue preserves structured dispatch input in session storage and renders it deterministically into model-visible context. Dispatched inputs emit agent lifecycle events correlated by instance, session, and `dispatchId`; they do not enter `/runs` or `flue logs`. Design external effects to be idempotent: interruption reconciliation avoids blind replay, but an explicit caller retry can still repeat effects whose prior outcome is unknown.

## Lifecycle and correlation

Workflows are finite executions and emit `run_start` and `run_end` events correlated by workflow `runId`. Agent prompt and dispatched-input processing emit finite `operation_start` and `operation` events with nested Pi-aligned `agent_start` and `agent_end`, message, turn, and tool lifecycle events. A session may process more inputs after becoming `idle`; `idle` is not a terminal run boundary. Direct interactions correlate by instance, session, and transport request when applicable; dispatched interactions additionally carry `dispatchId`. For external event consumers and model-turn telemetry, see [Observability](/docs/guide/observability/).

## `createAgent(...)`

Agent modules default-export a runtime initializer:

```ts
export default createAgent(({ id, env }) => ({
  profile: assistant,
  sandbox: getAccountSandbox(env, id),
  cwd: `/accounts/${id}`,
}));
```

For persistent agents, initialization is scoped only by stable `id`; message payloads are not provided to the initializer. Encode stable tenancy or resource scope in ids such as `account:acme` so repeated messages for one instance use consistent resources.

`createAgent(...)` may return:

- `profile`: one reusable `defineAgentProfile(...)` value;
- inline behavior fields that replace corresponding profile fields;
- `sandbox`: sandbox or resource attachment;
- `cwd`: session context root.

Session persistence is configured project-wide via `src/db.ts` rather than per-agent. See [Data Persistence API](/docs/api/data-persistence-api/).

Dynamic per-event routing belongs in application ingress logic before calling `dispatch(...)`.

## Provider event routing

An application route can dispatch zero, one, or many inputs, including to another agent module:

```ts
app.post('/webhooks/discord', async (c) => {
  const event = await verifyAndParseDiscordWebhook(c.req.raw);
  await Promise.all([
    dispatch(moderationAgent, {
      id: `guild:${event.guildId}`,
      session: `case:${event.caseId}`,
      input: { type: 'discord.message.flagged', message: event.message },
    }),
    dispatch(auditAgent, {
      id: `guild:${event.guildId}`,
      session: `event:${event.id}`,
      input: { type: 'audit.delivery_seen', eventId: event.id },
    }),
  ]);
  return c.json({ accepted: true }, 202);
});
```

The case and session model is application logic. For example, a moderation agent may choose `session = case:<caseId>` so evidence from multiple provider integrations routes into the same session.

## Current limitations

- There is no universal reply or thread abstraction yet.
- Provider retries may produce duplicate events. Preserve provider ids in your input if idempotency matters.
- WebSocket clients should use the published SDK and protocol surface. Include any custom public mount pathname in SDK `baseUrl` and use `websocketUrl` for URL-carried or signed handshake authentication.
- HTTP SDK `token` and `headers` options do not automatically authenticate WebSocket upgrades. Browser clients should use cookies or application-designed URL authentication.
- Exported `websocket` middleware can authenticate individual agent and workflow socket routes. Use a custom `app.ts` when you need centralized authentication or a mounted prefix. Avoid middleware that mutates WebSocket upgrade response headers.
