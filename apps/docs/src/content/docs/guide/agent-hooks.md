---
title: Agent Hooks
description: Compose an agent's capabilities — model, tools, skills, state, and lifecycle — with Flue's hook primitives.
lastReviewedAt: 2026-07-23
---

An agent function can return instructions, but instructions aren't much on their own. A real agent needs tools, skills, subagents, a sandbox, and persistent data to work with. All agent functionality and resources come from Flue's second core primitive — **agent hooks**.

This guide covers what hooks are, the built-in hooks Flue ships with, and how to compose them into hooks of your own. (New to Flue? Be sure to read the [Agents guide](/docs/guide/building-agents/) first.)

## What is an agent hook?

A hook is a plain function that you call inside your agent function's body to give your agent one new capability. You can spot hooks by their names — they all start with `use`. Each built-in hook lets your agent hook into a different feature of the Flue runtime:

- [Model](/docs/guide/models/) (`useModel`) selects the LLM that powers the agent.
- [Sandbox](/docs/guide/sandboxes/) (`useSandbox`) provides its filesystem and command-execution environment.
- [Tools](/docs/guide/tools/) (`useTool`) let it call application code and affect external systems.
- [MCP servers](/docs/guide/mcp/) (`useMcpConnection`) mount tools from the open MCP ecosystem.
- [Skills](/docs/guide/skills/) (`useSkill`) provide expertise it can load when needed.
- [Subagents](/docs/guide/subagents/) (`useSubagent`) let it delegate focused work to other agents.
- [Persisted State](#persisted-state) (`usePersistentState`) preserves custom data across the agent lifetime.
- [Event Hooks](#event-hooks) (`useAgentStart`, `useAgentFinish`, and others) trigger logic on different lifecycle events.
- [Data Writers](#streaming-data-to-the-client) (`useDataWriter`) stream structured data to your client UI.
- [Custom Hooks](#custom-hooks) let you compose new hooks out of the built-ins.

```ts title="src/agents/triage.ts"
'use agent';
import { useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import { searchIssues } from '../tools/search-issues.ts';
import reviewChecklist from '../skills/review-checklist/SKILL.md';

export function TriageAgent() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useTool(searchIssues);
  useSkill(reviewChecklist);
  return 'Investigate the reported issue and recommend the next action.';
}
```

Similar to React, the agent function _re-renders_ on every model call and re-runs its hooks. Unlike React, resource hooks can be added and removed conditionally. This allows Flue to manage your declared agent capabilities for you automatically, adding and removing resources (tools, skills, subagents, etc.) as your conversation with the agent evolves:

```ts title="src/agents/support-agent.ts"
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';
import refundTool from '../tools/refund.ts';

export function SupportAgent() {
  useModel('anthropic/claude-haiku-4-5');
  const [escalated, setEscalated] = usePersistentState('escalated', false);
  // Tools can modify persisted state.
  useTool({
    name: 'escalate',
    description: 'Escalate this conversation when the customer needs a refund.',
    async run() {
      setEscalated(true);
      return 'Escalated. The refund tool is now available.';
    },
  });
  // If the agent has determined that the conversation needs escalation,
  // the "refund" tool is unlocked and made available to the agent.
  if (escalated) {
    useTool(refundTool);
  }
  return 'Answer customer support questions clearly and accurately.';
}
```

Flue handles this complexity for you, announcing each change to the model and even preserving your cached prompt tokens across long-running sessions when possible.

Every built-in hook is documented in the [Agent API](/docs/reference/agent-api/) reference.

## Persisted state

An agent conversation can live for days or months, and along the way the agent learns things worth keeping: which phase of a workflow it's in, what it has already checked, decisions it has made. `usePersistentState` gives that knowledge a durable home:

```ts title="src/agents/case-assistant.ts"
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';

export function CaseAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  const [phase, setPhase] = usePersistentState('phase', 'gathering');
  const [factsChecked, setFactsChecked] = usePersistentState('factsChecked', 0);

  useTool({
    name: 'check_fact',
    description: 'Verify one case fact.',
    async run() {
      setFactsChecked((previous) => previous + 1);
    },
  });
  useTool({
    name: 'begin_draft',
    description: 'Call once the case facts are verified.',
    async run() {
      setPhase('drafting');
    },
  });

  return `Current phase: ${phase}. Facts checked: ${factsChecked}.`;
}
```

The signature looks like React's `useState`, but the value is durable: every write is recorded in the conversation's storage, and every render reads the latest value back — across turns, across restarts, for the life of the conversation. Values must be JSON-serializable, and each piece of state is keyed by its name.

When the next value derives from the current one, pass an updater function (`(previous) => previous + 1`) rather than computing from the render value: the render value is a snapshot, while an updater always sees the latest write.

Everything else an agent knows lives loosely in the conversation transcript; persistent state is the part your code can read and act on. That's what makes multi-step behavior possible: interpolate state into your instructions, gate tools and skills on it (as `SupportAgent` above shows), or use it as a guard so one-time work happens exactly once — `CaseAssistant`'s gathering-then-drafting flow is nothing more than hooks reading a `phase` value. See [Durability](/docs/guide/durability/) for how state is stored and recovered.

## Event hooks

Event hooks register callbacks that run at set moments in an agent's lifecycle.

- `useResponseStart()`
- `useAgentStart()` Runs every time a message is delivered to the agent.
- `useAgentFinish()`
- `useResponseFinish()`

`useAgentStart()` is special because it is async, which makes it the natural place to load data before the model runs. This can be especially useful for passing some loaded, initial data to the model in the agent instructions, or modifying capabilities based on the data loaded.

```ts title="src/agents/account-support.ts"
'use agent';
import { type AgentProps, useAgentStart, useModel, usePersistentState } from '@flue/runtime';
import { crm, type Customer } from '../shared/crm.ts';

export function AccountSupport({ id }: AgentProps) {
  useModel('anthropic/claude-haiku-4-5');
  const [customer, setCustomer] = usePersistentState<Customer | null>('customer', null);

  useAgentStart(async () => {
    if (customer) return; // load once per conversation
    setCustomer(await crm.lookupCustomer(id));
  });

  return customer
    ? `Help ${customer.name} (${customer.plan} plan) with their account.`
    : 'Help the customer with their account.';
}
```

`useResponseStart` and `useResponseFinish` run exactly once at each response's true start and true end (irrespective of how many messages were received by the agent). Any data returned from the callback is merged onto the response's **metadata** — an envelope field that your client reads outside the message content — making them the place to stamp timings, token usage, or your own application markers:

```ts
useResponseStart(() => ({ startedAt: Date.now() }));
useResponseFinish(({ metadata, response }) => ({
  elapsed: Date.now() - (metadata.startedAt as number),
  totalTokens: response.usage.totalTokens,
}));
```

Event hooks may be declared conditionally, just like resources. Their callbacks run at-least-once: completed work commits durably and is never repeated, while interrupted work is retried — so guard anything that must not happen twice (an outbound email, a page) with persistent state. The [Agent API](/docs/reference/agent-api/) documents each hook's full details.

## Passing data to the agent

You can pass structured data to an agent at creation time via `initialData`, and read it inside of your agent function with the `useInitialData()` hook.

```ts
'use agent';
import * as v from 'valibot';
import { useModel, useInitialData } from '@flue/runtime';

export function Triage() {
  useModel('anthropic/claude-opus-4-6');
  const data = useInitialData<v.InferOutput<typeof Triage.initialData>>();
  return `Triage GitHub issue #${data!.issue} end-to-end.`;
}
// Optional: Pass a schema object to type-check the initial data at runtime
Triage.initialData = v.object({ issue: v.pipe(v.number(), v.integer()) });
```

```ts
// Dispatch
await dispatch(Triage, {
  id: 'issue-17307',
  initialData: { issue: 17307 },
  message: 'New GitHub issue created.',
});
```

```bash
# CLI
flue run ./triage-agent.ts --id issue-17307 --data '{"issue": 17307}' \
  --message "New GitHub issue created."
```

```bash
# HTTP
curl -X POST https://example.com/agents/triage-agent/issue-17307 \
  -H 'Content-Type: application/json' \
  -d '{"initialData": {"issue": 17307}, "kind": "user", "body": "New GitHub issue created."}'
```

The `initialData` schema static validates the data once, at instance creation. Data sent to an existing instance is ignored; the recorded value never changes. Direct HTTP carries it the same way (`{ "initialData": {…}, "kind": "user", "body": "…" }`), as do `client.send({ message, initialData })` and `flue run --data '<json>'`.

## Streaming data to the client

An LLM replies with text, but a client often needs more structured data. This is especially common when a client is rendering some custom UI for the user: an order card, a progress meter, a chart, etc.

When you need to write structured data alongside the agent response, use the `useDataWriter()` hook. A data writer declares a named data channel and returns a write function that passes structured data to the client, keyed to the given name:

```ts title="src/agents/order-assistant.ts"
'use agent';
import { useDataWriter, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export function OrderAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  const writeOrderCard = useDataWriter('orderCard', {
    schema: v.object({ orderId: v.string(), status: v.picklist(['loading', 'loaded']) }),
  });

  useTool({
    name: 'lookup_order',
    description: 'Look up one order for the customer.',
    input: v.object({ orderId: v.string() }),
    async run({ data }) {
      writeOrderCard({ orderId: data.orderId, status: 'loading' });
      const order = await orders.get(data.orderId);
      writeOrderCard({ orderId: data.orderId, status: 'loaded' });
      return order.summary;
    },
  });

  return 'Help customers check the status of their orders.';
}
```

Each write is recorded durably and streamed to connected clients immediately — a tool can write several times mid-run to drive live progress, as `lookup_order` does above. On the wire, each write arrives as a named data part on the conversation message (`{ type: 'data-orderCard', data: … }`), separate from the text the model wrote. The optional `schema` validates every write.

On the client, data parts arrive alongside text parts on the same message. With [`@flue/react`](/docs/guide/react/), rendering them is one extra branch in your message-parts loop:

```tsx title="src/components/order-chat.tsx"
import { useFlueAgent } from '@flue/react';
import { OrderCard } from './order-card.tsx';

export function OrderChat({ conversationId }: { conversationId: string }) {
  const agent = useFlueAgent({ url: `/api/agents/order-assistant/${conversationId}` });

  return agent.messages.map((message) =>
    message.parts.map((part, index) => {
      if (part.type === 'text') return <p key={index}>{part.text}</p>;
      if (part.type === 'data-orderCard') {
        const order = part.data as { orderId: string; status: string };
        return <OrderCard key={index} {...order} />;
      }
      return null;
    }),
  );
}
```

The channel is strictly one-way, out of the agent: the model never sees data parts, and a write never re-runs the agent function. Declare data writers unconditionally, one unique name each — see the [Agent API](/docs/reference/agent-api/) for the full details.

## Custom hooks

Because hooks are plain function calls, you can extract related declarations into named, reusable pieces the same way React does: with **custom hooks**. A custom hook is a function that you define yourself, always prefixed with `use`. It may take arguments and return values to its caller, just like any other function:

```ts title="src/agents/support-assistant.ts"
import { useModel, useTool } from '@flue/runtime';
import { escalateCase } from '../shared/support-tools.ts';

function useEscalation() {
  useTool(escalateCase);
  return 'Escalate to a specialist only after you have confirmed the account and issue.';
}

function SupportAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  const escalationInstructions = useEscalation();
  return `Answer customer support questions accurately. ${escalationInstructions}`;
}
```

Custom hooks are how larger agents stay readable, and how capabilities get shared across agents — a `useGitHub()` hook that bundles the right tools, skills, and instructions can be written once and dropped into every agent that works with GitHub.

## Next steps

- [Agent Guide](/docs/guide/building-agents/) — the definitive guide about building agents in Flue.
- [Agent API](/docs/reference/agent-api/) — the full contract for every built-in hook.
- [Tools](/docs/guide/tools/), [Skills](/docs/guide/skills/), and [Sandboxes](/docs/guide/sandboxes/) — configure what an agent can do and where it works.
- [Subagents](/docs/guide/subagents/) — delegate focused work to a specialist agent function.
- [Durability](/docs/guide/durability/) — how persistent state, retries, and recovery work.
