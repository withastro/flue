# flue

> **Experimental** — Flue is under active development. APIs may change.

Agent framework where agents are directories compiled into deployable server artifacts.

## Packages

| Package                     | Description                             |
| --------------------------- | --------------------------------------- |
| [`@flue/sdk`](packages/sdk) | Core SDK: build system, sessions, tools |
| [`@flue/cli`](packages/cli) | CLI for building and running agents     |

## Examples

### Support Bot

A support agent that triages incoming requests and returns structured results.

```ts
// .flue/agents/support.ts
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const session = await init();

  const result = await session.prompt(`Triage this support request:\n\n${payload.message}`, {
    result: v.object({
      priority: v.picklist(['low', 'medium', 'high', 'critical']),
      category: v.string(),
      response: v.string(),
    }),
  });

  return result;
}
```

### Issue Triage Agent

A more complete agent that checks out a repo, investigates issues, and delegates focused tasks to sub-agents. Uses a real container sandbox, custom tools, roles, and structured output.

```ts
// .flue/agents/triage.ts
import { Type, type FlueContext, type ToolDef } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '@flue/connectors/daytona';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  // Spin up a real container sandbox via Daytona
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();

  const session = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
  });

  // Clone the repo into the sandbox
  await session.shell(`git clone ${payload.repo} /workspace/repo`);

  // Expose a custom tool so the LLM can delegate focused work to sub-agents
  const taskTool: ToolDef = {
    name: 'task',
    description:
      'Delegate a focused task to a sub-agent working in a specific directory. ' +
      'The sub-agent discovers AGENTS.md and skills from that directory automatically.',
    parameters: Type.Object({
      workspace: Type.String({ description: 'Directory for the sub-agent to work in' }),
      prompt: Type.String({ description: 'Instructions for the sub-agent' }),
    }),
    execute: async (args) => {
      const result = await session.task(args.prompt, { workspace: args.workspace });
      return result.text;
    },
  };

  // Triage the issue: the agent can read code, run tests, and delegate sub-tasks
  const result = await session.prompt(
    [
      `Investigate this issue in /workspace/repo:`,
      `**${payload.issue.title}**`,
      payload.issue.body,
      `Check if it's reproducible. If you can fix it, do so.`,
    ].join('\n\n'),
    {
      role: 'triager',
      tools: [taskTool],
      result: v.object({
        severity: v.picklist(['low', 'medium', 'high', 'critical']),
        reproducible: v.boolean(),
        summary: v.string(),
        fix_applied: v.boolean(),
      }),
    },
  );

  return result;
}
```

### Running Agents

```bash
# Build and run an agent locally
flue run support --target node --session-id req-1 \
  --payload '{"message": "I can not log in"}'

# Build the server for deployment (Node or Cloudflare Workers)
flue build --target node
node dist/server.mjs
```
