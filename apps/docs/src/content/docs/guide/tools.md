---
title: Tools
description: Give agents application capabilities through custom tools and MCP servers.
lastReviewedAt: 2026-05-29
---

Tools let an agent retrieve information or perform actions while it works. Define tools when an agent needs to call your application's data layer or services, such as looking up an order, creating a ticket, or approving a request.

A [skill](/docs/guide/skills/) provides reusable instructions; a tool executes application code. File and command access in an agent's workspace comes from its configured [sandbox](/docs/guide/sandboxes/) rather than from a custom application tool.

## Custom tools

Use `defineTool(...)` to create a new tool for your agent:

```ts title="src/shared/order-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

const orderStatuses = new Map([
  ['order_1042', 'packed'],
  ['order_1043', 'shipped'],
]);

export const lookupOrderStatus = defineTool({
  name: 'lookup_order_status',
  description: 'Look up the current fulfillment status for one order ID.',
  parameters: v.object({
    orderId: v.pipe(v.string(), v.description('Order ID in the form order_1234')),
  }),
  execute: async ({ orderId }) => {
    const status = orderStatuses.get(orderId);
    return status ?? 'No order was found.';
  },
});
```

A custom tool has four parts:

- `name` is the model-facing name used to call the tool.
- `description` helps the model decide when the capability is appropriate.
- `parameters` describes the inputs the model may supply. For authored tools, build this schema with [valibot](https://valibot.dev) (`v.object({ ... })`); a raw JSON Schema object is also accepted for schemas produced elsewhere.
- `execute` performs the application-controlled work and returns text for the model to use in its response. Arguments are validated and parsed against the schema before `execute` runs, so the callback receives typed values; when validation fails, the model receives the schema issues as a tool error and can retry with corrected arguments.

Use clear action-oriented names, such as `lookup_order_status` or `create_support_ticket`. Tools available during the same operation must have distinct names.

## Using tools

Provide a stable capability in the configuration for the agent that needs it:

```ts title="src/agents/order-assistant.ts"
import { defineAgent } from '@flue/runtime';
import { lookupOrderStatus } from '../shared/order-tools.ts';

export default defineAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Help customers check the status of their orders.',
  tools: [lookupOrderStatus],
}));
```

When this agent receives a request, the model can call `lookup_order_status` if it needs the current status before composing its answer. The call and returned text become part of the session context so the agent can continue working with the result.

Attach tools this way when they are part of an agent's ordinary capabilities. When a tool is needed for only one bounded action, you can instead provide it in the options for `session.prompt(...)`, `session.skill(...)`, or `session.task(...)`; see the [Agent API](/docs/api/agent-api/).

## Protect access

A tool's parameters are model-selected inputs, not an authorization boundary. Your application should decide which customer, account, repository, or credential a tool can use, then let the model select only values within that boundary.

For an addressable customer-support agent, the selected agent instance can establish which customer's orders are accessible:

```ts title="src/agents/customer-orders.ts"
import { defineAgent, defineTool } from '@flue/runtime';
import * as v from 'valibot';
import { orders } from '../shared/orders.ts';

export default defineAgent(({ id: customerId }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [
    defineTool({
      name: 'lookup_customer_order',
      description: 'Look up one order belonging to this customer.',
      parameters: v.object({
        orderId: v.string(),
      }),
      execute: async ({ orderId }) => {
        const status = await orders.getStatus(customerId, orderId);
        return status ?? 'No accessible order was found.';
      },
    }),
  ],
}));
```

In this example, the model may choose an order ID to look up, but it cannot choose the customer used in the query. Your route must still authenticate the caller and ensure that they may access the selected agent `id`; see [Agents](/docs/guide/building-agents/) and [Routing](/docs/guide/routing/).

The same principle applies in workflows. Configure bounded tools on the workflow's agent, and pass invocation-specific authorized identifiers through the Action input:

```ts title="src/workflows/review-orders.ts"
const lookupCustomerOrder = defineTool({
  name: 'lookup_customer_order',
  description: 'Look up one order belonging to the authenticated customer.',
  parameters: v.object({ orderId: v.string() }),
  execute: async ({ orderId }) => {
    const status = await orders.getStatus(customer.id, orderId);
    return status ?? 'No accessible order was found.';
  },
});

const agent = defineAgent(() => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [lookupCustomerOrder],
}));

export default defineWorkflow({
  agent,
  input: v.object({ orderId: v.string() }),
  async run({ harness, input }) {
    return await (await harness.session()).prompt(`Review order ${input.orderId}.`);
  },
});
```

Do not put credentials, tenant identifiers, or unrestricted destinations into model-selected tool arguments when trusted application code can supply them instead.

## Use provider SDKs directly

Channel integrations follow the same rule. Flue verifies inbound provider
events, while your application uses the provider SDK and defines only the
outbound actions its agents need:

```ts title="src/channels/github.ts"
import { defineTool } from '@flue/runtime';
import { Octokit } from '@octokit/rest';

export const client = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export function commentOnIssue(ref: { owner: string; repo: string; issueNumber: number }) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: 'Comment on the GitHub issue bound to this agent.',
    parameters: v.object({
      body: v.string(),
    }),
    async execute({ body }) {
      await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
      return 'Comment posted.';
    },
  });
}
```

The model controls the comment body. Trusted application code controls the
token, repository, and issue. Avoid generic provider tools that expose
arbitrary destinations or API methods unless the application has an explicit
authorization design for them.

## Connect MCP servers

An MCP server supplies remotely implemented tools. `connectMcpServer(...)` lists those tools and returns ordinary tool definitions, which you provide to agent work in the same way as your own custom tools.

```ts title="src/workflows/inventory-assistant.ts"
import { connectMcpServer, defineAgent, defineWorkflow } from '@flue/runtime';
import * as v from 'valibot';

type Env = {
  INVENTORY_MCP_URL: string;
  INVENTORY_MCP_TOKEN: string;
};

const inventory = await connectMcpServer('inventory', {
  url: process.env.INVENTORY_MCP_URL!,
  headers: { Authorization: `Bearer ${process.env.INVENTORY_MCP_TOKEN}` },
});

const agent = defineAgent<Env>(() => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: inventory.tools,
}));

export default defineWorkflow({
  agent,
  input: v.object({ question: v.string() }),
  async run({ harness, input }) {
    return await (await harness.session()).prompt(input.question);
  },
});
```

Provide MCP credentials and connection settings from trusted application code and close the connection during application shutdown. Flue prefixes each MCP tool's model-facing name with its connection name; for example, `lookup_item` from this server becomes `mcp__inventory__lookup_item`.

## Next steps

- [Agents](/docs/guide/building-agents/) — configure continuing agents that use tools.
- [Workflows](/docs/guide/workflows/) — initialize agent work with invocation-specific tools.
- [Skills](/docs/guide/skills/) — add reusable instructions that may direct an agent to use its tools.
- [Sandboxes](/docs/guide/sandboxes/) — control the workspace and command boundary available to agent work.
- [Agent API](/docs/api/agent-api/) — look up operation options, including tools supplied for one call.
