---
title: Tools
description: Give agents the ability to call your application code and act on external systems.
lastReviewedAt: 2026-07-23
---

A **tool** is a function you write, described to the model, that the model may call while it works — look up an order, file a ticket, issue a refund. The model decides _when_ to call; your code decides _what happens_. Where a [skill](/docs/guide/skills/) provides reusable instructions and the [sandbox](/docs/guide/sandboxes/) provides file and command access, a tool executes your application's code.

This guide covers defining custom tools and mounting them with `useTool`, the file and shell tools a sandbox brings, harness tools, durable tools, conditional tools, approval gates, and protecting what a tool can access.

## Your first tool

A tool definition has four parts: a `name` the model calls it by, a `description` that teaches the model when to use it, an optional `input` schema for its arguments, and a `run` function containing your code. Define it with `defineTool(...)`:

```ts title="src/tools/lookup-order.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export const lookupOrder = defineTool({
  name: 'lookup_order',
  description: 'Look up one order by id and return its current status.',
  input: v.object({ orderId: v.string() }),
  async run({ data }) {
    const order = await orders.get(data.orderId);
    return { output: { status: order.status, eta: order.eta } };
  },
});
```

Then mount it in an agent with the `useTool` hook:

```ts title="src/agents/order-assistant.ts"
'use agent';
import { useModel, useTool } from '@flue/runtime';
import { lookupOrder } from '../tools/lookup-order.ts';

export function OrderAssistant() {
  useModel('anthropic/claude-haiku-4-5');
  useTool(lookupOrder);
  return 'Help customers check the status of their orders.';
}
```

The model reads the tool's name, description, and input schema; when it decides the tool fits, it calls with arguments; Flue validates them against the schema, runs your `run` function, and returns the result to the model.

`defineTool(...)` validates the definition and returns it frozen — the natural shape for tools shared across agents from a `src/tools/` directory. For a one-off, `useTool` accepts the same definition object written inline (see the [conditional example below](#conditional-tools)). Either way, every active tool needs a unique name: a duplicate name, or a collision with a framework-reserved name like `task` or `activate_skill`, throws when the tool set is assembled.

## How a tool call works

**What the model sees.** Each mounted tool is presented to the model as its `name`, its `description`, and its `input` schema (converted to JSON Schema; a tool without an `input` schema presents an empty object). The description is the model's _only_ documentation: state what the tool does, when to use it, and what it returns. Vague descriptions are the most common cause of a tool being called incorrectly or not at all.

**Input.** The `input` schema is a [Valibot](https://valibot.dev) schema and must be a top-level object schema. Model-supplied arguments are parsed by it before `run` executes, and `run` receives the parsed value as `data`, fully typed. When validation fails, `run` is never called — the failure goes back to the model as a tool error so it can correct its arguments and retry.

**Output.** `run` returns a result envelope, `{ output?, terminate? }`, not a bare value. `output` is the JSON-compatible data (an object, array, string, number — anything JSON-serializable) that's JSON-stringified for the model, and a bare `string` return is shorthand for `{ output: <string> }`. Returning nothing is allowed only when no `output` schema is declared; any other bare return throws. `terminate: true` ends the agent's turn once the current tool batch settles, the same contract `finish`/`give_up` use. Add an optional `output` schema when the returned shape should be typed and validated too:

```ts
const checkInventory = defineTool({
  name: 'check_inventory',
  description: 'Check the stock level for one SKU.',
  input: v.object({ sku: v.string() }),
  output: v.object({ inStock: v.number(), warehouse: v.string() }),
  async run({ data }) {
    return { output: await inventory.lookup(data.sku) };
  },
});
```

**Errors.** A throw inside `run` does not crash the agent. It becomes an error result the model sees, so it can retry, try another approach, or tell the user. Throw (or return a descriptive failure value) rather than swallowing errors — the model can only respond to failures it can see.

**The rest of the context.** Alongside `data`, every `run` receives:

- `signal` — an `AbortSignal` for the call. Pass it to your own async work so a cancelled tool call stops promptly. A `run` that ignores the signal cannot wedge the agent: when the signal fires, the runtime abandons the await — the call fails with an `AbortError` saying the work may still be running, and the orphaned promise's eventual result is discarded.
- `log` — progress logging (`log.info(...)`, `log.warn(...)`, `log.error(...)`) for long-running tools. Lines stream into the conversation as events your application can observe; they are not part of the result and the model never sees them.
- `toolCallId` — the id of this specific call, the same id carried on the call's conversation events. Use it to correlate side effects with the call that raised them.

Optional flags on the definition extend the context further: `harness: true` adds `harness` and `durable: true` adds `step`, both covered below. The full contract lives in the [`defineTool` reference](/docs/reference/agent-api/#definetool).

## Built-in tools

An agent with a [sandbox](/docs/guide/sandboxes/) gains a standard set of built-in tools that operate on it (without one, these tools aren't in the set — the model can't call what isn't there):

| Tool    | What it does                                                         |
| ------- | -------------------------------------------------------------------- |
| `read`  | Read a file (truncated to 2000 lines or 50KB; supports offset/limit) |
| `write` | Write a file, creating it and parent directories as needed           |
| `edit`  | Edit a file by exact text replacement                                |
| `bash`  | Execute a shell command and return stdout/stderr                     |
| `grep`  | Search file contents for a regex pattern                             |
| `glob`  | Find files by filename pattern                                       |

Each tool's parameters, truncation limits, and error behavior are documented in [Agent Behavior — Built-in tools](/docs/reference/agent-behavior/#built-in-tools).

On top of these, the framework adds its own tools when the capability exists: `task` for [subagent delegation](/docs/guide/subagents/) (always present), `activate_skill` when the agent has [skills](/docs/guide/skills/), and `read_skill_resource` when a skill packages resource files. These names are reserved — a custom tool can't take them.

A sandbox adapter can replace this set with its own — see [Sandbox-provided tools](/docs/guide/sandboxes/#sandbox-provided-tools) and [`SandboxToolFactory`](/docs/reference/sandbox-api/#sandboxtoolfactory) in the Sandbox Adapter API.

## Harness tools

An ordinary tool is a pure function of its input: data in, result out. Declare `harness: true` when a tool needs to reach back into the agent's own runtime — its sandbox, or the model itself. The `run` function then receives `harness`, the tool's interface to both:

- `harness.sandbox` — the agent's live environment: `readFile`, `writeFile`, `exec`, and the other [sandbox verbs](/docs/reference/agent-api/#harnesssandbox), touched directly with no conversation record. Throws when the agent declared no [sandbox](/docs/guide/sandboxes/).
- `harness.prompt(text, options?)` — run a model operation in the harness's own scratch conversation. Repeated calls continue it, so a later prompt sees what earlier calls established. Pass `options.result` (a Valibot schema) to require validated structured data, or `options.tools` to offer extra tools for just that operation.

A harness tool can stage inputs, run focused model work, and validate the result behind one tool call:

```ts title="src/tools/review-contract.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const Report = v.object({ riskLevel: v.picklist(['low', 'medium', 'high']), summary: v.string() });

export const reviewContract = defineTool({
  name: 'review_contract',
  description: 'Review one supplied contract and return a structured risk report.',
  input: v.object({ contract: v.string() }),
  harness: true,
  async run({ harness, data }) {
    await harness.sandbox.writeFile('contract.md', data.contract);
    const { data: report } = await harness.prompt(
      'Review contract.md for non-standard terms and assess the risk.',
      { result: Report },
    );
    return { output: report };
  },
});
```

Harness invocations are scoped to the tool call: the harness materializes when the call runs and closes when it settles. They count against the delegation-depth cap, and any child conversations they open are retained on the parent conversation for inspection — the same accounting a delegated [subagent](/docs/guide/subagents/) uses. Because a harness only exists inside an agent session, `harness: true` tools never run standalone; tools without the flag cannot reach the runtime at all. See the [Harness reference](/docs/reference/agent-api/#harness) for the full surface.

## Durable tools

When a process crashes mid-turn, Flue recovers the conversation from its durable records — but an ordinary tool call that was in flight is _not_ re-executed. The runtime can't know which side effects already happened, so the interrupted call settles with an unknown-outcome error and the model continues from there.

For work that must complete — a payment, a multi-step sync, a provisioning job — declare the tool `durable: true`. That opts it into a different contract: `run` receives `step`, and every side effect goes through `step.do(name, fn)`:

```ts title="src/tools/provision-workspace.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { billing, projects, DEFAULT_PROJECTS } from '../shared/provisioning.ts';

export const provisionWorkspace = defineTool({
  name: 'provision_workspace',
  description: 'Provision a customer workspace: create the tenant, then seed each default project.',
  input: v.object({ customerId: v.string() }),
  durable: true,
  async run({ data, step }) {
    const tenant = await step.do('create-tenant', () => billing.createTenant(data.customerId));
    for (const project of DEFAULT_PROJECTS) {
      await step.do(`seed:${project.name}`, () => projects.seed(tenant.id, project));
    }
    return { output: { tenantId: tenant.id, projects: DEFAULT_PROJECTS.length } };
  },
});
```

`step.do(name, fn)` runs `fn` once per name for the tool call and durably records its returned value before resolving. When an interruption strikes mid-run, recovery re-executes the whole call: completed steps return their recorded values without running again, and execution continues from the first step that never finished. If the crash landed between `create-tenant` and the third `seed:` step above, the re-run replays the tenant and the first two seeds from their records and picks up at the third.

Four rules:

- **Everything effectful goes in a step.** Code between steps re-executes on recovery, so keep it cheap and effect-free — derive values, branch, loop.
- **Names identify the work.** Derive them deterministically (`seed:${project.name}`), never from randomness or timing. Reusing a name within one call throws.
- **Values are JSON and should stay small.** Store large artifacts in the sandbox and record a pointer.
- **Steps are exactly-once-recorded, at-least-once-executed.** A crash in the narrow window between a step finishing and its record landing re-runs that one step, so steps around external effects should be individually idempotent.

Step records are operational bookkeeping: the model sees only the tool's final result, and step progress surfaces live as the call's log events. A thrown error is not an interruption — like any tool, a durable tool that throws settles the call as a tool error the model sees, and nothing retries automatically. Steps are scoped to one call: when the model invokes the tool again, they run fresh. The flags compose — a `durable: true, harness: true` tool receives both `step` and `harness`; wrap `harness.prompt(...)` in a step so recovery doesn't re-prompt. See [Durability](/docs/guide/durability/#durable-tools-and-stepdo) for how this fits the wider recovery model.

## Bounded tools

A tool whose internals hang — a transport that never observes its abort signal, an unbounded response-body read, a wedged SDK call — can silently consume an entire submission's durability budget while every turn around it looks healthy. Declare `timeoutMs` to bound one call:

```ts title="src/tools/lookup-catalog.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const lookupCatalog = defineTool({
  name: 'lookup_catalog',
  description: 'Query the upstream catalog API.',
  input: v.object({ sku: v.string() }),
  timeoutMs: 15_000,
  async run({ data, signal }) {
    const response = await fetch(`https://catalog.example.com/${data.sku}`, { signal });
    // …
  },
});
```

When the deadline expires, the harness aborts the tool's `context.signal` (signal-aware code can clean up), settles the call with a `ToolTimeoutError` — surfaced to the model as the tool's error result, distinct from a thrown tool error — and discards the abandoned run's late settlement. The conversation continues: the model sees `Tool "<name>" timed out after <ms>ms` and can retry or change approach, while the submission's [durability timeout](/docs/guide/durability/) remains the outer backstop. A host abort (a session abort, a deployment) still lands as an abort, not a timeout.

## Conditional tools

The agent function re-renders before every model call, and each render declares its tool set from scratch. That makes a tool's _presence_ just another piece of program logic: wrap `useTool` in a condition, and the tool exists only in the renders where the condition holds. Gate it on [persistent state](/docs/guide/agent-hooks/#persisted-state) and the agent can unlock its own capabilities:

```ts title="src/agents/release-manager.ts"
'use agent';
import { useModel, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { approvals } from '../shared/approvals.ts';
import { publishRelease } from '../tools/publish-release.ts';

export function ReleaseManager() {
  useModel('anthropic/claude-sonnet-4-6');
  const [approved, setApproved] = usePersistentState('approved', false);

  useTool({
    name: 'record_approval',
    description: 'Record an operator approval code for this release.',
    input: v.object({ code: v.string() }),
    async run({ data }) {
      if (!(await approvals.verify(data.code))) return 'Invalid approval code.';
      setApproved(true);
      return 'Approval recorded. The publish tool is now available.';
    },
  });

  if (approved) useTool(publishRelease);

  return 'Prepare the release. Publishing unlocks once an operator approves.';
}
```

Until an operator approves, `publish_release` doesn't exist — an unmounted tool can't be called, a stronger guarantee than an instruction not to use it. When the set changes between renders, the runtime announces the delta to the model in a `resources` signal at the next turn boundary ("New tool available: …"), keeping the transcript coherent. See [Dynamic resources](/docs/reference/agent-api/#dynamic-resources) for exactly how changes are narrated.

> **Note:** Changing the tool set rewrites the provider's tools array, which invalidates its prompt cache, so gate tools on state that changes rarely. The exception is a tool unlocked by a completed tool call, the way `record_approval` unlocks `publish_release` here: current Anthropic models (except Haiku) load its definition at the point in the conversation where it appeared, and the cache survives.

Tools built this way pair naturally with [custom hooks](/docs/guide/agent-hooks/#custom-hooks): a `useEscalation()` hook that bundles the gate, the tools, and the matching instructions can be shared across every agent that needs the same behavior.

## Approval gates

A conditional tool unlocks a whole _capability_. Sometimes you need a person to approve one specific call — this refund, this release, these arguments — before it runs. Flue has no built-in approval API; this section shows a pattern built from the hooks above that you can copy and adapt.

Don't make a tool's `run` wait for a person. While a tool call is running, the agent's response is still in progress, and a new message only joins it at a turn boundary, so the approval could never arrive. The wait would also count against the submission's [durability timeout](/docs/guide/durability/#retry-budget-and-timeout), and an interrupted call is not re-run. Instead, record the request and end the response. The decision arrives later as its own message, and the agent runs the stored call then:

1. The model calls the tool. `run` saves the exact arguments in [persistent state](/docs/guide/agent-hooks/#persisted-state), keyed by the call's `toolCallId`, and returns a `pending_approval` result with `terminate: true`. The response ends and the conversation goes idle — no process waits for anyone.
2. Your application shows the request to a person: a card in your UI, a button in a chat channel.
3. A trusted route delivers the decision into the conversation as a signal.
4. A [`useAgentStart`](/docs/reference/agent-hooks-api/#useagentstart) callback, which runs before the model reads that signal, executes the stored arguments on approval — not whatever the model might send next time — and appends the outcome for the model to read.

The gate as a custom hook:

```ts title="src/shared/use-approval-gate.ts"
import { useAgentStart, useDelivery, usePersistentState, useTool } from '@flue/runtime';
import * as v from 'valibot';

type PendingCall = { args: unknown; requestedAt: string };

export function useApprovalGate<TInput extends v.GenericSchema<Record<string, unknown>>>(gate: {
  name: string;
  description: string;
  input: TInput;
  /** Return false to run a call without asking. Omit to always ask. */
  needsApproval?: (args: v.InferOutput<TInput>) => boolean;
  /** The side effect. Returns a summary for the model; `approvalId` doubles as an idempotency key. */
  execute: (args: v.InferOutput<TInput>, approvalId: string) => Promise<string>;
}) {
  const [pending, setPending] = usePersistentState<Record<string, PendingCall>>(
    `approvals:${gate.name}`,
    {},
  );
  const delivery = useDelivery();

  useTool({
    name: gate.name,
    description: `${gate.description} Some calls need operator approval before they run.`,
    input: gate.input,
    async run({ data, toolCallId }) {
      if (gate.needsApproval && !gate.needsApproval(data)) {
        return { output: { status: 'executed', result: await gate.execute(data, toolCallId) } };
      }
      setPending((previous) => ({
        ...previous,
        [toolCallId]: { args: data, requestedAt: new Date().toISOString() },
      }));
      return { output: { status: 'pending_approval', approvalId: toolCallId }, terminate: true };
    },
  });

  useAgentStart(async ({ append }) => {
    if (delivery.kind !== 'signal' || delivery.type !== 'tool-approval') return;
    const { approvalId = '', decision, approver = 'An operator' } = delivery.attributes ?? {};
    const call = pending[approvalId];
    if (!call) return; // not this gate's request, or already decided

    setPending(({ [approvalId]: _decided, ...rest }) => rest);

    if (decision !== 'approve') {
      append({
        kind: 'signal',
        type: 'tool-approval-result',
        body: `${approver} denied ${gate.name} (${approvalId}). Do not retry it; ask how to proceed.`,
      });
      return;
    }
    try {
      const result = await gate.execute(call.args as v.InferOutput<TInput>, approvalId);
      append({
        kind: 'signal',
        type: 'tool-approval-result',
        body: `${approver} approved ${gate.name} (${approvalId}). Result: ${result}`,
      });
    } catch (error) {
      append({
        kind: 'signal',
        type: 'tool-approval-result',
        body: `${gate.name} (${approvalId}) was approved but failed: ${String(error)}`,
      });
    }
  });
}
```

An agent mounts it like any custom hook. Here prereleases publish immediately and stable releases wait for approval:

```ts title="src/agents/release-manager.ts"
'use agent';
import { useModel } from '@flue/runtime';
import * as v from 'valibot';
import { releases } from '../shared/releases.ts';
import { useApprovalGate } from '../shared/use-approval-gate.ts';

export function ReleaseManager() {
  useModel('anthropic/claude-sonnet-4-6');

  useApprovalGate({
    name: 'publish_release',
    description: 'Publish a tagged release to npm.',
    input: v.object({ pkg: v.string(), version: v.string() }),
    needsApproval: ({ version }) => !version.includes('-next'),
    async execute({ pkg, version }, approvalId) {
      const { url } = await releases.publish({ pkg, version, idempotencyKey: approvalId });
      return `Published ${pkg}@${version}: ${url}`;
    },
  });

  return 'Prepare releases. Stable releases need operator approval before they publish.';
}
```

The decision comes in through a route you control, not straight from the browser into the conversation: anyone who can post to the conversation could otherwise approve calls. The route authenticates the approver, then [`dispatch`es](/docs/guide/building-agents/#dispatch) the signal. Keying the dispatch on the approval id means the first decision wins — a second, different decision for the same request is rejected with a `409`:

```ts title="src/app.ts"
import { dispatch } from '@flue/runtime';
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { ReleaseManager } from './agents/release-manager.ts';
import { requireOperator } from './shared/auth.ts';

const app = new Hono();

app.route('/api/agents/release-manager', createAgentRouter(ReleaseManager));

app.post('/api/approvals/:conversationId', async (c) => {
  const operator = await requireOperator(c.req.raw);
  const { approvalId, decision } = await c.req.json<{
    approvalId: string;
    decision: 'approve' | 'deny';
  }>();

  const receipt = await dispatch(ReleaseManager, {
    id: c.req.param('conversationId'),
    message: {
      kind: 'signal',
      type: 'tool-approval',
      body: `${operator.name} chose "${decision}" for ${approvalId}.`,
      attributes: { approvalId, decision, approver: operator.name },
    },
    idempotencyKey: `approval:${approvalId}`,
  });

  return c.json(receipt, 202);
});

export default app;
```

A [channel](/docs/guide/channels/) handles its provider's button-click webhook the same way: verify it, then dispatch the same signal.

On the client, a pending request is an ordinary `dynamic-tool` part whose `output.status` is `pending_approval`. The part's `input` holds the arguments to show the approver. The decision signal carries `approvalId` in its attributes, so a request is decided once a message with that attribute appears:

```tsx title="src/ui/Approvals.tsx"
import { type FlueConversationMessage, useFlueAgent } from '@flue/react';

function pendingApprovals(messages: FlueConversationMessage[]) {
  const decided = new Set(
    messages.flatMap((message) => message.signal?.attributes?.approvalId ?? []),
  );
  return messages.flatMap((message) =>
    message.parts.flatMap((part) =>
      part.type === 'dynamic-tool' &&
      part.state === 'output-available' &&
      (part.output as { status?: string } | null)?.status === 'pending_approval' &&
      !decided.has(part.toolCallId)
        ? [{ approvalId: part.toolCallId, toolName: part.toolName, input: part.input }]
        : [],
    ),
  );
}

export function Approvals({ conversationId }: { conversationId: string }) {
  const agent = useFlueAgent({ url: `/api/agents/release-manager/${conversationId}` });

  async function decide(approvalId: string, decision: 'approve' | 'deny') {
    await fetch(`/api/approvals/${conversationId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approvalId, decision }),
    });
  }

  return (
    <ul>
      {pendingApprovals(agent.messages).map(({ approvalId, toolName, input }) => (
        <li key={approvalId}>
          <code>{toolName}</code>
          <pre>{JSON.stringify(input, null, 2)}</pre>
          <button onClick={() => decide(approvalId, 'approve')}>Approve</button>
          <button onClick={() => decide(approvalId, 'deny')}>Deny</button>
        </li>
      ))}
    </ul>
  );
}
```

Things to keep in mind when adapting the pattern:

- **Make `execute` idempotent.** `useAgentStart` callbacks are at-least-once: a crash while one runs re-runs it on the next attempt. Pass `approvalId` to the external system as an idempotency key, as `releases.publish` does above.
- **The request ends the response without a reply.** `terminate: true` stops the model before it writes any text, so the approval card is what the user sees. Leave `terminate` off if you'd rather the model say it is waiting; the call still won't run until approved.
- **Decide what happens with no person present.** A conversation started by a [schedule](/docs/guide/schedules/) or a webhook may have nobody watching. Use `needsApproval`, or a check on `useDelivery()`, to deny or skip those calls rather than leaving them pending.
- **Requests don't expire on their own.** They stay in persistent state until decided. To expire them, have a scheduled job dispatch a `deny` decision for requests older than your limit.
- **The transcript records two steps.** The original tool call keeps its `pending_approval` result, and the real outcome arrives later as a `tool-approval-result` signal.

[MCP tool annotations](/docs/guide/mcp/) such as `destructiveHint` can feed `needsApproval` for tools from a server you trust. They are hints supplied by the server, so use them to require approval, never to skip it.

## Protect access

A tool's arguments are model-selected inputs, not an authorization boundary. Your application should decide which customer, account, repository, or credential a tool can use, then let the model select only values within that boundary.

For an agent that receives dispatched, per-customer events — a support-system webhook, a chat platform message — carry the authorized identifier your application already validated in the delivered signal's `attributes`, and read it with `useDelivery()` rather than trusting a model-supplied value:

```ts title="src/agents/customer-orders.ts"
'use agent';
import { useDelivery, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export function CustomerOrders() {
  useModel('anthropic/claude-haiku-4-5');
  const delivery = useDelivery();
  const customerId = delivery.kind === 'signal' ? delivery.attributes?.customerId : undefined;

  useTool({
    name: 'lookup_customer_order',
    description: 'Look up one order belonging to this customer.',
    input: v.object({ orderId: v.string() }),
    async run({ data }) {
      const status = customerId ? await orders.getStatus(customerId, data.orderId) : undefined;
      return status ?? 'No accessible order was found.';
    },
  });

  return 'Help this customer check the status of their orders.';
}
```

The model may choose an order ID to look up, but it cannot choose the customer used in the query — `customerId` comes from the delivered signal's `attributes`, set by the trusted code that called `dispatch(...)`. Your route or dispatching code must still verify the caller before attaching that identifier; see [Agents](/docs/guide/building-agents/) and [Routing](/docs/guide/routing/).

The same principle applies everywhere a tool touches something the model shouldn't select: inside a [harness tool](#harness-tools), and in tools that wrap a provider SDK, where trusted code binds the token, repository, or destination — through a closure or configuration — and the tool exposes only the narrow action. See [Use provider SDKs](/docs/guide/channels/#use-provider-sdks) in the Channels guide for that pattern; avoid generic provider tools that expose arbitrary destinations or API methods unless the application has an explicit authorization design for them.

## Connect MCP servers

Remote [MCP](https://modelcontextprotocol.io) servers plug into this same tool set: `useMcpConnection(...)` declares a server, and the runtime mounts its tools as `mcp__<server>__<tool>` entries alongside your `useTool` mounts. See the [MCP guide](/docs/guide/mcp/) for connecting, choosing which tools to mount, authentication, and connecting at module scope.

## Next steps

- [Agent Hooks](/docs/guide/agent-hooks/) — the hook model that `useTool` belongs to, including persistent state and custom hooks.
- [Agent API](/docs/reference/agent-api/) — the full `defineTool`, `useTool`, `ToolContext`, and harness contracts.
- [Sandboxes](/docs/guide/sandboxes/) — the environment that brings the built-in file and shell tools.
- [Subagents](/docs/guide/subagents/) — delegate focused work through the built-in `task` tool.
- [Durability](/docs/guide/durability/) — how conversations, state, and durable tool steps are recovered.
