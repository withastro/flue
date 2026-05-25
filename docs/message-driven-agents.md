# Message-Driven Agents

Flue has two execution products:

- **Workflows return results.** Use workflows for finite request/result jobs.
- **Agents receive messages.** Use agents for addressable instances that may receive many inputs over time.

This guide covers message-driven agents, direct attached surfaces, and authored inbound channel applications. Channel support is inbound-only today. Flue does not automatically post replies, reactions, cards, or issue comments after an agent processes an input. Future outward effects should happen through explicit tools.

## Agent Model

An agent is a module under `.flue/agents/` or `agents/`.

The important runtime concepts are:

- **Agent module**: source file such as `.flue/agents/moderator.ts`.
- **Agent profile**: reusable behavior created with `defineAgentProfile(...)`.
- **Created agent**: runtime initializer created with `createAgent(...)`.
- **Agent instance**: durable actor identified by `{ agentName, instanceId }`.
- **Session**: isolated conversation/context stream inside one instance.
- **Channel event**: normalized inbound provider event emitted by a channel adapter.
- **Dispatch**: one structured input accepted for one target agent instance/session.

Agent modules default-export `createAgent(...)` so the runtime can initialize an instance when messages arrive. For provider events, they import a channel and register top-level `channel.on(...)` listeners.

## Direct Attached Surfaces

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

- targets one explicit agent module and instance id
- initializes the instance through its default `createAgent(...)` export
- bypasses channel listeners
- bypasses `dispatch(...)`
- can stream runtime events with HTTP `Accept: text/event-stream` or a WebSocket connection

Direct agent prompts are attached session interactions. They do not allocate or return a `runId`, emit workflow `run_start` / `run_end`, or appear in `/runs` and `flue logs`.

Agent WebSockets are long lived: a single connection may issue sequential prompts, each optionally selecting a named session. Prompt frames are correlated by transport `requestId` and selected instance/session, not by a run identifier. Workflows may also declare `websocket()`, but a workflow socket accepts exactly one invocation and then closes after its terminal result because it represents one finite workflow run.

```ts
import { createAgent, defineAgentProfile, http, websocket } from '@flue/runtime';

export const channels = [http(), websocket()];

const assistant = defineAgentProfile({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'You are a helpful direct chat assistant.',
});

export default createAgent(({ id, env }) => ({
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

## Authored Channels

Provider adapters are discovered from `.flue/channels/*` or `channels/*`. A channel owns a Hono application, parses and verifies its transport input, and emits normalized typed events. Its application is mounted below `/channels/:name/*` through `flue()`:

```ts
// .flue/channels/github.ts
import { defineChannel } from '@flue/runtime';
import { Hono } from 'hono';

interface GitHubEvents {
  issues: { deliveryId: string; payload: Record<string, any> };
}
interface GitHubThread {
  channel: 'github';
  deliveryId: string;
}

const app = new Hono();
const github = defineChannel<GitHubEvents, GitHubThread>({ app });

app.post('/events', async (c) => {
  const event = await verifyAndParseGitHubWebhook(c.req.raw);
  const result = await github.emit('issues', {
    event,
    thread: { channel: 'github', deliveryId: event.deliveryId },
  });
  return c.json({ accepted: true, ...result }, 202);
});

export default github;
```

Agent modules import that singleton and own event interest and routing:

```ts
// .flue/agents/github-triage.ts
import { createAgent, defineAgentProfile, dispatch } from '@flue/runtime';
import github from '../channels/github.ts';

const triage = defineAgentProfile({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'You triage inbound GitHub webhook events.',
});
const agent = createAgent(() => ({ profile: triage }));

github.on('issues', async ({ event }) => {
  const repository = event.payload.repository?.full_name;
  const issue = event.payload.issue?.number;
  if (typeof repository !== 'string' || typeof issue !== 'number') return;

  await dispatch(agent, {
    id: `repo:${repository}`,
    session: `issue:${issue}`,
    input: { type: 'github.issue', deliveryId: event.deliveryId },
  });
});

export default agent;
```

Channel event delivery:

- invokes registered `channel.on(...)` listeners for that typed event
- lets each listener ignore, transform, or explicitly `dispatch(...)` work
- acknowledges webhook admission before model processing completes
- does not imply any outbound provider action

## `channel.on(...)`

`channel.on(...)` is the agent-owned routing hook for provider events emitted by an authored channel application. It should filter events, extract references, choose a target instance/session, and shape narrow structured input for the agent.

## `dispatch(...)`

Use `dispatch(...)` inside a channel listener to admit structured input into an agent session:

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

- `agent`: target agent module name in the named overload; use `dispatch(createdAgent, request)` when a created-agent reference is available
- `id`: target agent instance id
- `session`: target session id; defaults to `default`
- `input`: JSON-like structured payload

`await dispatch(...)` means the input was accepted and queued for the target session according to the current runtime's guarantees. It does not mean the model finished processing, produced a reply, or completed tool calls. The returned `dispatchId` identifies asynchronous delivery and any delivery recovery or idempotency behavior; it is not a run ID.

Flue preserves the structured input in session storage and renders it deterministically into model-visible context. Dispatched inputs emit agent lifecycle events correlated by instance/session and `dispatchId`; they do not enter `/runs` or `flue logs`.

## Lifecycle and Correlation

Workflows are finite executions and emit `run_start` / `run_end` events correlated by workflow `runId`. Agent prompt and dispatched-input processing emit finite `operation_start` / `operation` events with nested Pi-aligned `agent_start` / `agent_end`, message, turn, and tool lifecycle events. A session may process more inputs after becoming `idle`; `idle` is not a terminal run boundary. Direct interactions correlate by instance/session and transport request when applicable; dispatched interactions additionally carry `dispatchId`. For external event consumers and model-turn request/output telemetry, see [Observability](observability.md).

## `createAgent(...)`

Agent modules default-export a runtime initializer:

```ts
export default createAgent(({ id, env }) => ({
  profile: assistant,
  sandbox: getAccountSandbox(env, id),
  cwd: `/accounts/${id}`,
  persist: getAccountStore(env, id),
}));
```

For persistent agents, initialization is scoped only by stable `id`; message payloads are not provided to the initializer. Encode stable tenancy or resource scope in ids such as `account:acme` so repeated messages for one instance use consistent resources.

`createAgent(...)` may return:

- `profile`: one reusable `defineAgentProfile(...)` value
- inline behavior fields that replace corresponding profile fields
- `sandbox`: sandbox/resource attachment
- `cwd`: session context root
- `persist`: persistence control

Dynamic per-event routing belongs in `channel.on(...)` before calling `dispatch(...)`.

## GitHub Webhooks

See `examples/github-webhook/.flue/channels/github.ts` for an authored GitHub adapter that verifies `X-Hub-Signature-256`, parses inbound payloads, and emits typed events. It is discovered and mounted at:

```txt
POST /channels/github/events
```

The example agent imports that channel, registers `github.on(...)` listeners, and explicitly dispatches accepted work. Set `GITHUB_WEBHOOK_SECRET` to enable signature verification.

## Cross-Channel Routing

A channel listener can dispatch zero, one, or many inputs, including to another agent module:

```ts
discord.on('message.created', async ({ event }) => {
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
});
```

The case/session model is application logic. For example, a moderation agent may choose `session = case:<caseId>` so Discord evidence and Google Chat reviewer discussion route into the same session.

## Current Limitations

- Authored channel applications are inbound-only.
- There is no universal reply/thread abstraction yet.
- Provider retries may produce duplicate events; preserve provider ids in your input if idempotency matters.
- WebSocket clients should use the published SDK/protocol surface. Configure SDK `websocketBasePath` for custom-mounted socket routes and `websocketUrl` for URL-carried or signed handshake authentication.
- HTTP SDK `token` and `headers` options do not automatically authenticate WebSocket upgrades; browser clients should use cookies or application-designed URL authentication.
- When using a custom `app.ts`, protect every exposed agent/workflow WebSocket route with ordinary application middleware before mounting `flue()`; without a custom app, protect production socket routes upstream. Avoid middleware that mutates WebSocket upgrade response headers.
