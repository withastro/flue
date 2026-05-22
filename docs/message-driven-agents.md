# Message-Driven Agents

Flue has two execution products:

- **Workflows return results.** Use workflows for finite request/result jobs.
- **Agents receive messages.** Use agents for addressable instances that may receive many inputs over time.

This guide covers message-driven agents, direct attached surfaces, and inbound external channels. External-channel support is inbound-only today. Flue does not automatically post replies, reactions, cards, or issue comments after an agent runs. Future outward effects should happen through explicit tools.

## Agent Model

An agent is a module under `.flue/agents/` or `agents/`.

The important runtime concepts are:

- **Agent module**: source file such as `.flue/agents/moderator.ts`.
- **Agent profile**: reusable behavior created with `defineAgentProfile(...)`.
- **Created agent**: runtime initializer created with `createAgent(...)`.
- **Agent instance**: durable actor identified by `{ agentName, instanceId }`.
- **Session**: isolated conversation/context stream inside one instance.
- **Delivery**: normalized inbound event from an external channel.
- **Dispatch**: one structured input accepted for one target agent instance/session.

Agent modules default-export `createAgent(...)` so the runtime can initialize an instance when messages arrive. Use `receive(...)` only for external-channel delivery routing.

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
- initializes the instance through its default `createAgent(...)` export
- bypasses `receive(...)`
- bypasses `dispatch(...)`
- can stream runtime events with `Accept: text/event-stream`

```ts
import { createAgent, defineAgentProfile } from '@flue/runtime';
import { http } from '@flue/runtime/channels';

export const channels = [http()];

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

## External Channels

External channels receive provider events through routers that you mount in `app.ts`:

```txt
app.route('/webhooks/github', createGitHubChannelRouter())
```

For example, GitHub webhooks may use:

```txt
POST /webhooks/github
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

Channel connectors can live in a normal `.flue/channels.ts` module, and agent modules subscribe with a `channels` export:

```ts
// .flue/channels.ts
import { createGitHubChannel } from '@flue/runtime/github';

export const github = createGitHubChannel();
```

```ts
// .flue/agents/github-triage.ts
import { createAgent, defineAgentProfile, type ReceiveContext } from '@flue/runtime';
import { github } from '../channels';

export const channels = [github()];

const triage = defineAgentProfile({
  model: 'anthropic/claude-haiku-4-5',
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

export default createAgent(() => ({ profile: triage }));
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

Dynamic per-delivery routing belongs in `receive(...)` before calling `dispatch(...)`.

## GitHub Webhooks

Define the GitHub channel in `.flue/channels.ts`:

```ts
import { createGitHubChannel } from '@flue/runtime/github';

export const github = createGitHubChannel();
```

Mount the GitHub router in `.flue/app.ts`:

```ts
import { flue } from '@flue/runtime/app';
import { createGitHubChannelRouter } from '@flue/runtime/github';
import { Hono } from 'hono';

const app = new Hono();
app.route('/', flue());
app.route('/webhooks/github', createGitHubChannelRouter());

export default app;
```

Then subscribe from an agent:

```ts
import { github } from '../channels';

export const channels = [github()];
```

The route is whatever you mount in `app.ts`; the example above uses `/webhooks/github`.

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
