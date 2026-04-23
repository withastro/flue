# flue

> **Experimental** — Flue is under active development. APIs may change.

Agent framework where agents are directories compiled into deployable server artifacts.

## Packages

| Package                                   | Description                                |
| ----------------------------------------- | ------------------------------------------ |
| [`@flue/sdk`](packages/sdk)               | Core SDK: build system, sessions, tools    |
| [`@flue/cli`](packages/cli)               | CLI for building and running agents        |
| [`@flue/connectors`](packages/connectors) | Third-party connectors for sandboxes, etc. |

## Examples

### Quickstart

The simplest agent — no container, no tools, just a prompt and a typed result.

```ts
// .flue/agents/hello-world.ts
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

// Every agent needs a trigger. This agent is invoked as an API endpoint, via HTTP.
export const triggers = { webhook: true };

// The agent handler. Where the orchestration of the agent lives.
export default async function ({ init, payload, sessionId }: FlueContext) {
  // `session` -- Your session with the agent, including sandbox, message history, etc.
  // By default, calling `init()` with no arguments gets you a completely empty agent,
  // with no skills, AGENTS.md, or files.
  const session = await init();

  // prompt() sends a message in the session, triggering action.
  // You can pass a schema to `result` to get typed, validated JSON back.
  const result = await session.prompt(`Translate this to ${payload.language}: "${payload.text}"`, {
    result: v.object({
      translation: v.string(),
      confidence: v.picklist(['low', 'medium', 'high']),
    }),
  });

  return result;
}
```

### Support Agent

A support agent, also running in a virtual sandbox but now with an R2 bucket mounted as its file-system. The knowledge base is stored in R2 and mounted directly into the agent's filesystem — the agent searches it with its built-in tools (grep, glob, read).

Session message history and file-system state are automatically persisted using Durable Objects (Cloudflare only). So you can revisit this session days, weeks, or years later and pick up where you left off automatically.

```ts
// .flue/agents/support.ts
import { getVirtualSandbox } from '@flue/sdk/cloudflare';
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  // Mount the R2 knowledge base bucket as the agent's filesystem.
  // The agent can grep, glob, and read articles with bash, but
  // without needing to spin up an entire container sandbox.
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
  const session = await init({ sandbox });

  return await session.prompt(
    `You are a support agent. Search the knowledge base for articles
    relevant to this request, then write a helpful response.

    Customer: ${payload.message}`,
  );
}
```

### Issue Triage (CI)

A triage agent that runs whenever a new issue is opened (or commented on) on GitHub, running on GitHub Actions.

Flue was designed to power CI workflows since day one. The `"local"` filesystem sandbox enables two things:

1. Mount the current directory to your virtual file system.
2. Connect privileged CLIs to your agent (`gh`, `glab`, `git`) without leaking sensitive keys and secrets.

```ts
// .flue/agents/triage.ts
import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

export const triggers = {};

// Connect privileged CLIs to your agent without leaking sensitive keys and secrets.
// Secrets are hooked up inside the command definition here, so your agent never sees them.
// Commands are controlled per-prompt, so you can be as granular with access as you need.
const npm = defineCommand('npm');
const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });

export default async function ({ init, payload }: FlueContext) {
  // 'local' mounts the host filesystem at /workspace — ideal for CI
  // where the repo is already checked out. Skills and AGENTS.md are
  // discovered automatically from the workspace directory.
  const session = await init({ sandbox: 'local' });

  const result = await session.skill('triage', {
    // Pass arguments to any prompt or skill.
    args: { issueNumber: payload.issueNumber },
    // Grant access to `gh` and `npm` for the life of this skill.
    commands: [gh, npm],
    // Provide roles (aka subagents) to guide your agent. Defined in .flue/roles/
    role: 'triager',
    // Result schemas are great for being able to act/orchestrate
    // based on the result of your prompt or skill call.
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
      fix_applied: v.boolean(),
    }),
  });

  return result;
}
```

### Coding Agent (Container Sandbox)

The examples above all run on a lightweight virtual sandbox — no container needed. But for a full coding agent, you want a real Linux environment with git, Node.js, a browser, and a cloned repo ready to go.

Daytona's declarative image builder lets you define the environment in code. The image is cached after the first build, so subsequent sessions start instantly.

```ts
// .flue/agents/code.ts
import { Type, type FlueContext, type ToolDef } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '@flue/connectors/daytona';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  // Each session gets a real container via Daytona. The container has
  // a full Linux environment with persistent filesystem and shell.
  //
  // For simplicity, we always create a new sandbox here. You could also
  // first check for an existing sandbox for the sessionId, and reuse that
  // instead to best pick up where you last left off in the conversation.
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  const session = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
  });

  // For simplicity, we clone the target repo into the sandbox here.
  // You could also bake these into the container image snapshot for a
  // faster / near-instant startup.
  await session.shell(`git clone ${payload.repo} /workspace/project`);
  await session.shell('npm install', { cwd: '/workspace/project' });

  // Coding agents don't hide the agent DX from the user, so no need to
  // wrap the user's prompt in anything. Just send it to the agent directly
  // and then stream back the progress and final results.
  return await session.prompt(payload.prompt);
}
```

## Running Agents

### Trigger From the CLI

Build and run any agent locally, perfect for fast local testing or running in CI.

```bash
flue run hello --target node --session-id test-1 \
  --payload '{"text": "Hello world", "language": "French"}'
```

### Trigger From HTTP Endpoint

Build and deploy your agents as a web server, perfect for hosted agents.

`flue build` builds to a `./dist` directory, which you can then deploy anywhere. Cloudflare and any Node.js host are supported today, with more coming in the future.

```
flue build --target node          # Node.js server
flue build --target cloudflare    # Cloudflare Workers + Durable Objects
```
