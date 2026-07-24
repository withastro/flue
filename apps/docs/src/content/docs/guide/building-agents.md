---
title: Agents
description: Create an agent, configure its capabilities, and send it messages over time.
lastReviewedAt: 2026-07-23
---

Flue is a framework for building autonomous **Agents**. They are at the heart of why Flue exists, so it's important to understand what they are and how they work. This guide covers creating an agent, composing its capabilities and environment, and exposing it safely to users.

## What is an agent?

An agent is made up of three key parts, all working together: **LLM, harness, and specialized context.** Flue is designed to help you customize and compose together all three elements to build powerful, truly autonomous agents to power all sorts of products and internal workflows.

Flue ships with two core primitives to help you compose powerful agents: **Agent Functions** and **Agent Hooks**.

## Agent Functions

An agent function represents an agent in Flue. In Flue, an agent is a JavaScript function that returns the agent's `system` prompt instructions. Those instructions are rendered, and then passed to the LLM along with the user and assistant messages that make up some agent conversation or workflow.

```ts title="src/agents/triage-agent.ts"
// Example: A simple agent, written in Flue.
function TriageAgent() {
  return "Investigate the user's issue and recommend the next action.";
}
```

An agent is always initialized with an ID. You can provide one via the `--id` flag to `flue run` (optional) or the `POST /:id` route of a hosted agent (required). It's up to you what the ID means — a user ID, a support ticket, a GitHub issue number, or just a random string. Each agent instance is persisted by ID, so you can use the agent ID to message with a specific agent over time.

```ts title="src/agents/triage-agent.ts"
function TriageAgent({ id }) {
  return `Investigate GitHub issue #${id} and recommend the next action.`;
}
```

There are other ways to pass (structured) data to your agent — see [Passing data to the agent](/docs/guide/agent-hooks/#passing-data-to-the-agent) in the Agent Hooks guide.

The agent function _re-renders_ on every turn. That is, every time the model is about to be called, Flue runs your function again and rebuilds its instructions from scratch. The string you return always reflects the agent's current state at that moment:

```ts title="src/agents/assistant-agent.ts"
function AssistantAgent() {
  // Warning: Inserting dynamic data into your agent instructions can bust the cache
  // that LLMs use to give you cheaper inference tokens. It's often a best practice
  // to avoid doing this in production agents, specifically to save money.
  return `You are a helpful assistant. The time now is ${Date.now()}.`;
}
```

If it helps, you can think of an agent function as similar to a React component render function. This is not accidental, as you'll soon see below: Flue agent functions were intentionally modeled after React to help unlock more expressive, more powerful agent functionality.

## Agent Hooks

An agent function isn't much on its own. It returns instructions, but a working agent needs more than words — a model, tools, a workspace, memory. To unlock all of that, you'll reach for Flue's second core primitive: **agent hooks**.

A hook is a plain function that you call inside your agent function's body to give your agent one new capability. All hooks start with `use`, and the naming is the idea: each one lets your agent _hook into_ a different feature of the Flue runtime:

- [Model](/docs/guide/models/) (`useModel`) selects the LLM that powers the agent.
- [Sandbox](/docs/guide/sandboxes/) (`useSandbox`) provides its filesystem and command-execution environment.
- [Tools](/docs/guide/tools/) (`useTool`) let it call application code and affect external systems.
- [MCP servers](/docs/guide/mcp/) (`useMcpConnection`) mount tools from the open MCP ecosystem.
- [Skills](/docs/guide/skills/) (`useSkill`) provide expertise it can load when needed.
- [Subagents](/docs/guide/subagents/) (`useSubagent`) let it delegate focused work to other agents.
- [Persisted State](/docs/guide/agent-hooks/#persisted-state) (`usePersistentState`) preserves custom data across the agent lifetime.
- [Event Hooks](/docs/guide/agent-hooks/#event-hooks) (`useAgentStart`, `useAgentFinish`, and others) trigger logic on different lifecycle events.

```ts title="src/agents/triage.ts"
import { useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { searchIssues } from '../tools/search-issues.ts';
import reviewChecklist from '../skills/review-checklist/SKILL.md';

function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useTool(searchIssues);
  useSkill(reviewChecklist);
  return 'Investigate the reported issue and recommend the next action.';
}
```

To learn more about agent hooks, see [Agent Hooks](/docs/guide/agent-hooks/).

## "use agent" Directive

The examples above define agent functions, but your application doesn't know about them yet. To register an agent, mark its module with the `'use agent'` directive and export the function:

```ts title="src/agents/triage-agent.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}
```

Like `'use strict'` in JavaScript or `'use client'` in React, the directive is a plain string at the top of the file, before any imports or other statements. At build time, Flue scans your project for marked files and registers every exported, capitalized function as an agent. One file may export several agents.

Registration is what makes an agent addressable by the rest of your application: `dispatch(...)` can send it messages, and `createAgentRouter(...)` can serve it over HTTP. The exported function's name also becomes the agent's durable identity, which keys its conversation storage in the persistent database. To rename the function without a database migration, pin the identity with the [`agentName` static](/docs/reference/agent-api/#agent-statics). Setting an explicit agent name is considered a best-practice by some Flue developers.

```ts title="src/agents/triage-agent.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  return 'Investigate the reported issue and recommend the next action.';
}

TriageAgent.agentName = 'triage-agent';
```

## Interacting with your agent

There are several ways to interact with an agent. All of them run the same agent and durability APIs — they differ only in how the runtime starts and whether an HTTP server exists.

### CLI

The easiest way to interact with your agent is locally, with the `flue run` CLI command:

```bash
flue run src/agents/triage-agent.ts --message "Triage issue 17307"
```

This runs one agent module directly — no server, no application build. Pass `--id` to name the conversation so you can continue it across invocations; without it, each run starts a fresh conversation and prints its generated id:

```bash
flue run src/agents/triage-agent.ts --id issue-17307 --message "Look at issue 17307"
flue run src/agents/triage-agent.ts --id issue-17307 --message "Any update?"
```

Conversations persist between runs — in your project's configured database, or a local cache file without one. See the [`flue run` reference](/docs/cli/run/) for agent selection, structured output, and the full flag list.

### HTTP

Agents mounted in your application are served over HTTP (mounting is covered in [Routing](/docs/guide/routing/)). Each conversation has its own URL, ending in the conversation id. `POST` a message to it:

```http title="Prompt a support agent conversation"
POST /agents/support-assistant/ticket-8472 HTTP/1.1
Content-Type: application/json

{
  "kind": "user",
  "body": "Can you summarize the open issues in my case?"
}
```

Prompts are fire-and-forget: the server responds `202` immediately, and the agent's reply is read from the conversation — `GET` the same URL to follow its events, or use the [Flue Agent SDK](/docs/sdk/overview/), which wraps the whole surface (`send()`, `wait()`, `observe()`, `history()`) around one conversation URL.

Anyone who can reach a conversation URL can talk to that conversation. Protect the mount with your application's normal middleware: verify the caller, and check that they're allowed to access that conversation id. See [Routing](/docs/guide/routing/) for the full pattern.

### `dispatch()`

Use `dispatch(...)` when your application receives an event for an agent asynchronously, such as a webhook, queue message, chat event, or notification. For example, an application route can verify an incoming support-system webhook and dispatch the comment to the agent for that ticket:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { Hono } from 'hono';
import { SupportAssistant } from './agents/support-assistant.ts';
import { verifySupportWebhook } from './shared/support-webhooks.ts';

const app = new Hono();

app.post('/webhooks/support-comments', async (c) => {
  const event = await verifySupportWebhook(c.req.raw);
  const receipt = await dispatch(SupportAssistant, {
    id: event.ticketId,
    message: {
      kind: 'signal',
      type: 'support.comment.created',
      body: event.text,
      attributes: { commentId: event.commentId },
    },
  });

  return c.json(receipt, 202);
});

export default app;
```

Your application chooses the agent conversation before dispatching the event. `dispatch(...)` accepts it for asynchronous processing rather than waiting for an agent response. Because registration comes from the `'use agent'` scan, an agent used only through `dispatch(...)` needs no mount at all. See [Channels](/docs/guide/channels/) for verified provider ingress and application-owned outbound behavior.

### Standalone scripts

Finally, you can run agents outside of a Flue application entirely — no server, no `app.ts` — with the more advanced `start()` API. It boots the Flue runtime inside your own Node.js process, which is useful for cron jobs, one-off scripts, and tests:

```ts title="scripts/nightly.ts"
import { init } from '@flue/runtime';
import { sqlite, start } from '@flue/runtime/node';
import { Reporter } from '../src/agents/reporter.ts';

await using flue = await start({
  agents: [Reporter],
  db: sqlite('./nightly.db'),
});

const reporter = init(Reporter, { id: 'nightly-2026-07-16' });
const receipt = await reporter.dispatch('Produce the nightly report.');
const reply = await reporter.read(receipt);
console.log(reply.text);
```

Provider credentials come from the process environment, and the `db` option decides whether conversations outlive the script: omit it for in-memory state, or pass an adapter like `sqlite()` so a later run can continue the same conversation. Inside an already-running Flue application there is no `start()` — call `init()` or `dispatch()` directly. The [Workflows](/docs/guide/workflows/) guide covers this scripting surface in depth, from CI pipelines to durable orchestration.

## Next steps

- [Agent Hooks](/docs/guide/agent-hooks/) — compose your agent's capabilities: tools, skills, state, and event hooks.
- [Agent API](/docs/reference/agent-api/) — look up session operations and their results.
- [Routing](/docs/guide/routing/) — mount agent HTTP surfaces inside an authenticated application.
- [Schedules](/docs/guide/schedules/) — dispatch agent input on a schedule.
- [Channels](/docs/guide/channels/) — deliver verified provider events into agent conversations.
- [Observability](/docs/guide/observability/) — inspect agent activity.
