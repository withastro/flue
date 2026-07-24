---
title: Tools
description: Give agents the ability to call your application code and act on external systems.
lastReviewedAt: 2026-07-23
---

A **tool** is a function you write, described to the model, that the model may call while it works — look up an order, file a ticket, issue a refund. The model decides _when_ to call; your code decides _what happens_. Where a [skill](/docs/guide/skills/) provides reusable instructions and the [sandbox](/docs/guide/sandboxes/) provides file and command access, a tool executes your application's code.

This guide covers defining custom tools and mounting them with `useTool`, the file and shell tools a sandbox brings, harness tools, durable tools, conditional tools, and protecting what a tool can access.

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
    return { status: order.status, eta: order.eta };
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

**Output.** `run` returns JSON-compatible data (an object, array, string, number — anything JSON-serializable), which is JSON-stringified for the model. Returning `undefined` sends `null`. Add an optional `output` schema when the returned shape should be typed and validated too:

```ts
const checkInventory = defineTool({
  name: 'check_inventory',
  description: 'Check the stock level for one SKU.',
  input: v.object({ sku: v.string() }),
  output: v.object({ inStock: v.number(), warehouse: v.string() }),
  async run({ data }) {
    return inventory.lookup(data.sku);
  },
});
```

**Errors.** A throw inside `run` does not crash the agent. It becomes an error result the model sees, so it can retry, try another approach, or tell the user. Throw (or return a descriptive failure value) rather than swallowing errors — the model can only respond to failures it can see.

**The rest of the context.** Alongside `data`, every `run` receives:

- `signal` — an `AbortSignal` for the call. Pass it to your own async work so a cancelled tool call stops promptly.
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

On top of these, the framework adds its own tools when the capability exists: `task` for [subagent delegation](/docs/guide/subagents/) (always present), `activate_skill` when the agent has [skills](/docs/guide/skills/), and `read_skill_resource` when a skill packages resource files. These names are reserved — a custom tool can't take them.

A sandbox adapter can replace this set with its own — see [Sandbox-provided tools](/docs/guide/sandboxes/#sandbox-provided-tools) and [`SessionToolFactory`](/docs/reference/sandbox-api/#sessiontoolfactory) in the Sandbox API.

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
    return report;
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
    return { tenantId: tenant.id, projects: DEFAULT_PROJECTS.length };
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

Until an operator approves, `publish_release` doesn't exist — an unmounted tool can't be called, a stronger guarantee than an instruction not to use it. When the set changes between renders, the runtime announces the delta to the model in a `resources` signal at the next turn boundary ("New tool available: …"), keeping the transcript coherent while preserving the provider's prompt cache. See [Dynamic resources](/docs/reference/agent-api/#dynamic-resources) for exactly how changes are narrated.

Tools built this way pair naturally with [custom hooks](/docs/guide/agent-hooks/#custom-hooks): a `useEscalation()` hook that bundles the gate, the tools, and the matching instructions can be shared across every agent that needs the same behavior.

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
