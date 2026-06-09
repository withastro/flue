---
title: Agents
description: Create an agent, configure its capabilities, and send it messages over time.
lastReviewedAt: 2026-05-29
---

Agents are useful when your application needs a model to keep working within a continuing context. This guide covers creating an agent, configuring its capabilities and environment, and exposing it safely to users.

For the underlying mental model, start with [What is an agent?](/docs/concepts/agents/). If you need single-use or background work instead of a continuing agent, see [Workflows](/docs/guide/workflows/).

## Creating a new agent

In a Flue project, an agent is a file in `src/agents/` whose default export is created with `createAgent(...)`:

```ts title="src/agents/joke-teller.ts"
import { createAgent, type AgentRouteHandler, type AgentWebSocketHandler } from '@flue/runtime';

export const route: AgentRouteHandler = async (_c, next) => next();
export const websocket: AgentWebSocketHandler = async (_c, next) => next();

export default createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Tell a short joke in response to each message.',
}));
```

In this example:

- **The filename:** This gives the agent its name: `joke-teller`.
- `route`: This exposes the agent over HTTP at `POST /agents/joke-teller/:id`.
- `websocket`: This exposes the agent over WebSocket at `GET /agents/joke-teller/:id`.
- `createAgent(...)`: This defines the agent's behavior and environment.

See [Project Layout](/docs/guide/project-layout/) and [Models & Providers](/docs/guide/models/) for more information.

## Agent configuration

The object returned by `createAgent(...)` defines the agent's behavior, capabilities, and environment. For example, a repository reviewer can be given review instructions, reusable tools and skills, and a local workspace to work within:

```ts title="src/agents/repository-reviewer.ts"
import { createAgent } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import reviewChecklist from '../skills/review-checklist/SKILL.md' with { type: 'skill' };
import { repositoryTools } from '../shared/repository-tools.ts';

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Review the requested change and report only findings supported by evidence.',
  cwd: '/srv/repositories/catalog-service',
  tools: repositoryTools,
  skills: [reviewChecklist],
  sandbox: local(),
}));
```

For more details, see [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), [Sandboxes](/docs/guide/sandboxes/), and [Database](/docs/guide/database/).

## Agent ID

Each agent is initialized with an `id`, which identifies the continuing instance of that agent.

```text
POST /agents/support-assistant/ticket-8472
                               └─────────┘ id
```

It's up to the developer to decide what `id` means and whether it maps to important application data, such as a user ID, customer support ticket, or GitHub issue. A randomly generated ID can also work.

Flue passes that ID to `createAgent(...)`, where the application can configure the resources that belong to that instance. For example, a support agent can receive tools scoped to one ticket:

```ts title="src/agents/support-assistant.ts"
import { createAgent, type AgentRouteHandler } from '@flue/runtime';
import { createTicketTools } from '../shared/support-tickets.ts';

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Help the customer understand and resolve their support ticket.',
  tools: createTicketTools(id),
}));
```

In this example, the agent can access the ticket selected by its `id`, but its tools do not give it access to other tickets. Conversation history belongs in the session store, while durable application data should remain in your own data layer.

## Agent profiles

An agent profile defines reusable behavior and capabilities without creating a public agent or configuring its runtime resources. Use profiles to share an agent's model, instructions, tools, or skills across your project.

```ts title="src/agents/support-assistant.ts"
import { createAgent, defineAgentProfile, type AgentRouteHandler } from '@flue/runtime';
import { supportTools } from '../shared/support-tools.ts';

const support = defineAgentProfile({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Answer customer support questions clearly and accurately.',
  tools: supportTools,
});

export default createAgent(() => ({
  profile: support,
}));
```

`createAgent(...)` can replace profile fields such as the model or instructions, and add tools, skills, or subagents needed for a specific agent.

## Subagents

Subagents are another use for agent profiles: they let an agent delegate focused work to another agent.

```ts title="src/agents/policy-assistant.ts"
import { createAgent, defineAgentProfile, type AgentRouteHandler } from '@flue/runtime';
import { local } from '@flue/runtime/node';

const policyResearcherSubagent = defineAgentProfile({
  name: 'policy_researcher',
  description: 'Finds relevant policy text and quotes the supporting passages.',
  instructions: 'Read the policy workspace and return supporting quotations with file paths.',
});

export default createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Answer policy questions only after delegating source lookup to policy_researcher.',
  sandbox: local(),
  cwd: '/srv/company-policies',
  subagents: [policyResearcherSubagent],
}));
```

Here, `policy-assistant` can use its built-in task capability to delegate source lookup to `policy_researcher` before answering a policy question. The subagent is available to its parent for delegated work. It does not receive its own public endpoint because it is not exported as the agent for that file.

For more information, see [Subagents](/docs/guide/subagents/).

## Interacting with your agent

Users can interact directly with an agent over HTTP or WebSocket. In either case, your application must verify that the caller can access the selected agent `id`.

### HTTP

An agent with a `route` export accepts HTTP messages at `POST /agents/<name>/<id>`. The body contains a message:

```http title="Prompt a support agent instance"
POST /agents/support-assistant/ticket-8472 HTTP/1.1
Authorization: Bearer <token>
Content-Type: application/json

{
  "message": "Can you summarize the open issues in my case?"
}
```

Use the `route` handler to protect direct HTTP access to an agent instance:

```ts title="src/agents/support-assistant.ts"
import { createAgent, type AgentRouteHandler } from '@flue/runtime';
import { authenticate } from '../auth.ts';

export const route: AgentRouteHandler = async (c, next) => {
  const principal = await authenticate(c.req.header('authorization'));
  const ticketId = c.req.param('id');

  if (!principal) return c.json({ error: 'Unauthorized' }, 401);
  if (!principal.supportTicketIds.includes(ticketId)) return c.notFound();

  await next();
};

export default createAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: `Help with authorized support ticket ${id}.`,
}));
```

### WebSocket

Export `websocket` when an interactive client should send multiple messages to the same agent instance over one connection:

```ts title="src/agents/support-assistant.ts"
import { createAgent, type AgentWebSocketHandler } from '@flue/runtime';
import { authenticate } from '../auth.ts';

export const websocket: AgentWebSocketHandler = async (c, next) => {
  const principal = await authenticate(c.req.header('authorization'));
  const ticketId = c.req.param('id');

  if (!principal) return c.json({ error: 'Unauthorized' }, 401);
  if (!principal.supportTicketIds.includes(ticketId)) return c.notFound();

  await next();
};

export default createAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
}));
```

For more information, see [Routing](/docs/guide/routing/) and [SDK](/docs/sdk/overview/).

## `dispatch()`

Use `dispatch(...)` when your application receives an event for an agent asynchronously, such as a webhook, queue message, chat event, or notification. For example, an application route can verify an incoming support-system webhook and dispatch the comment to the agent for that ticket:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';
import { Hono } from 'hono';
import supportAssistant from './agents/support-assistant.ts';
import { verifySupportWebhook } from './shared/support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await verifySupportWebhook(c.req.raw);
  const receipt = await dispatch(supportAssistant, {
    id: event.ticketId,
    input: {
      type: 'support.comment.created',
      commentId: event.commentId,
      text: event.text,
    },
  });

  return c.json(receipt, 202);
});

app.route('/', flue());

export default app;
```

Your application chooses the agent instance before dispatching the event. `dispatch(...)` accepts it for asynchronous processing rather than waiting for an agent response. For a complete chat integration pattern, see [Chat](/docs/guide/chat/).

## Next steps

- [Agent API](/docs/api/agent-api/) — look up session operations and their results.
- [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), and [Sandboxes](/docs/guide/sandboxes/) — configure what an agent can do and where it works.
- [Subagents](/docs/guide/subagents/) — delegate focused work to specialist profiles.
- [Routing](/docs/guide/routing/) — expose agent HTTP and WebSocket surfaces inside an authenticated application.
- [Workflows](/docs/guide/workflows/) — run single-use or background agent work.
- [Chat](/docs/guide/chat/) and [Observability](/docs/guide/observability/) — deliver asynchronous messages and inspect agent activity.
