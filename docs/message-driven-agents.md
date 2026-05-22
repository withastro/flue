# Message-Driven Agents

Flue has two execution products:

- **Workflows return results.** Use workflows for finite request/result jobs.
- **Agents receive messages.** Use agents for addressable instances that may receive many inputs over time.

This guide covers message-driven agents, direct attached surfaces, and inbound external channels. External-channel support is inbound-only today. Flue does not automatically post replies, reactions, cards, or issue comments after an agent runs. Future outward effects should happen through explicit tools.

## Agent Model

An agent is a module under `.flue/agents/` or `agents/`.

The important runtime concepts are:

- **Agent module**: source file such as `.flue/agents/moderator.ts`.
- **Agent definition**: reusable profile created with `defineAgent(...)`.
- **Agent instance**: durable actor identified by `{ agentName, instanceId }`.
- **Session**: isolated conversation/context stream inside one instance.
- **Delivery**: normalized inbound event from an external channel.
- **Dispatch**: one structured input accepted for one target agent instance/session.

Use `init(...)` to wake or construct an agent instance. Use `receive(...)` only for external-channel delivery routing.

## Direct Attached Surfaces

Direct attached surfaces already know the target agent instance. HTTP direct delivery uses:

```txt
POST /agents/:name/:id
```

The current HTTP payload is provisional:

```json
{
  "message": "Summarize the current issue",
  "session": "default"
}
```

If `session` is omitted, Flue uses the `default` session.

Direct delivery:

- targets one explicit agent module and instance id
- wakes the instance through `init(...)`
- bypasses `receive(...)`
- bypasses `dispatch(...)`
- can stream runtime events with `Accept: text/event-stream`

```ts
import { defineAgent, type AgentInitContext } from '@flue/runtime';
import { http } from '@flue/runtime/channels';

export const channels = [http()];

const assistant = defineAgent({
  instructions: 'You are a helpful direct chat assistant.',
});

export async function init({ id, spawn }: AgentInitContext) {
  // `id` comes from /agents/assistant/:id.
  return spawn({ inherit: assistant });
}
```

Example request:

```bash
curl http://localhost:3583/agents/assistant/user-123 \
  -H "Content-Type: application/json" \
  -d '{"message":"Hello","session":"thread:1"}'
```

## External Channels

External channels receive provider events at a shared channel endpoint:

```txt
POST /channels/:channel
```

For example, GitHub webhooks use:

```txt
POST /channels/github
```

The connector verifies and normalizes the provider event into a `Delivery`:

```ts
type Delivery = {
  id: string;
  channel: string;
  type: string;
  data: unknown;
  occurredAt?: string;
  raw?: unknown;
};
```

Channel connectors live in `.flue/channels/`, and agent modules subscribe with a `channels` export:

```ts
// .flue/channels/github.ts
import { createGitHubChannel } from '@flue/runtime/github';

export const channel = createGitHubChannel();
```

```ts
// .flue/agents/github-triage.ts
import { defineAgent, type AgentInitContext, type ReceiveContext } from '@flue/runtime';
import { channel as github } from '../channels/github';

export const channels = [github()];

const triage = defineAgent({
  instructions: 'You triage inbound GitHub webhook events.',
});

export async function receive({ delivery, dispatch }: ReceiveContext) {
  if (delivery.type !== 'issues') return;

  const data = delivery.data as { payload?: Record<string, any>; action?: string };
  const payload = data.payload ?? {};
  const repository = payload.repository as Record<string, any> | undefined;
  const issue = payload.issue as Record<string, any> | undefined;
  if (typeof repository?.full_name !== 'string' || typeof issue?.number !== 'number') return;

  await dispatch({
    id: `repo:${repository.full_name}`,
    session: `issue:${issue.number}`,
    input: {
      type: 'github.issue',
      deliveryId: delivery.id,
      action: data.action,
      repository: repository.full_name,
      issue: issue.number,
      title: issue.title,
      url: issue.html_url,
    },
  });
}

export async function init({ spawn }: AgentInitContext) {
  return spawn({ inherit: triage });
}
```

External-channel delivery:

- fans out to every agent module subscribed to that channel
- calls each subscribed module's `receive(...)`
- lets `receive(...)` ignore, transform, or dispatch the delivery
- acknowledges webhook admission before model processing completes
- does not imply any outbound provider action

## `receive(...)`

`receive(...)` is the routing hook for external channels.

It should:

- filter irrelevant deliveries
- extract meaningful provider references
- choose the target agent module when dispatching elsewhere
- choose the target instance id
- choose the target session id
- shape narrow structured input for the model

It should not:

- initialize agent instances directly
- act like a model turn
- execute tools on behalf of the model
- return an HTTP response to the provider

## `dispatch(...)`

Use `dispatch(...)` inside `receive(...)` to admit structured input into an agent session:

```ts
await dispatch({
  agent: 'audit',
  id: 'account:acme',
  session: 'event:github-delivery-123',
  input: {
    type: 'audit.external_delivery_observed',
    deliveryId: delivery.id,
  },
});
```

Fields:

- `agent`: optional target agent module name; defaults to the current module
- `id`: target agent instance id
- `session`: target session id
- `input`: JSON-like structured payload

`await dispatch(...)` means the input was accepted and queued for the target session according to the current runtime's guarantees. It does not mean the model finished processing, produced a reply, or completed tool calls.

Flue preserves the structured input in session storage and renders it deterministically into model-visible context.

## `init(...)`

`init(...)` is the instance wake-up hook. It receives the target instance id and a narrow `spawn(...)` helper:

```ts
export async function init({ id, spawn }: AgentInitContext) {
  return spawn({
    inherit: assistant,
  });
}
```

Keep `init(...)` instance-oriented. It should not receive or branch on the original channel delivery or dispatched input payload.

`spawn(...)` accepts instance-construction options such as:

- `inherit`: reusable `defineAgent(...)` profile
- `sandbox`: sandbox/resource attachment
- `cwd`: session context root
- `persist`: persistence control

Dynamic per-delivery behavior belongs in `receive(...)` or in reusable agent definitions, not in `spawn(...)`.

## GitHub Webhooks

Define the GitHub channel in `.flue/channels/github.ts`:

```ts
import { createGitHubChannel } from '@flue/runtime/github';

export const channel = createGitHubChannel();
```

Then subscribe from an agent:

```ts
import { channel as github } from '../channels/github';

export const channels = [github()];
```

When a channel module named `github` exports a GitHub channel, the generated runtime wires `/channels/github` to the GitHub webhook handler.

Set `GITHUB_WEBHOOK_SECRET` to verify `X-Hub-Signature-256` signatures:

```bash
GITHUB_WEBHOOK_SECRET="your-webhook-secret"
```

The normalized GitHub delivery preserves:

- delivery id from `X-GitHub-Delivery`
- event type from `X-GitHub-Event`
- action when present
- repository, sender, and installation objects when present
- original parsed payload under `data.payload`
- selected webhook headers and raw body under `raw`

See `examples/github-webhook` for a complete inbound-only example.

## Cross-Channel Routing

One delivery can dispatch zero, one, or many inputs. It can also dispatch to another agent module:

```ts
export async function receive({ delivery, dispatch }: ReceiveContext) {
  if (delivery.channel === 'discord' && delivery.type === 'message.created') {
    const data = delivery.data as { guildId: string; caseId: string; message: unknown };

    await dispatch({
      id: `guild:${data.guildId}`,
      session: `case:${data.caseId}`,
      input: {
        type: 'discord.message.flagged',
        message: data.message,
      },
    });

    await dispatch({
      agent: 'audit',
      id: `guild:${data.guildId}`,
      session: `delivery:${delivery.id}`,
      input: {
        type: 'audit.delivery_seen',
        deliveryId: delivery.id,
      },
    });
  }
}
```

The case/session model is application logic. For example, a moderation agent may choose `session = case:<caseId>` so Discord evidence and Google Chat reviewer discussion route into the same session.

See `examples/cross-channel-routing` for a mock inbound routing example. It uses mock `discord` and `gchat` channel definitions because those real connectors are not implemented yet.

## Current Limitations

- External-channel delivery is inbound-only.
- There is no universal reply/thread abstraction yet.
- Provider retries may produce duplicate deliveries; preserve provider ids in your input if idempotency matters.
- Cloudflare external-channel dispatch processing is not durable yet and currently fails clearly for unsupported processing paths.
- The direct HTTP payload shape is provisional.
