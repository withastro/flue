> **Experimental** — Flue is under active development. APIs may change.
>
> Looking for `v0.0.x`? [See here.](https://github.com/withastro/flue/tree/v0.0.x)

# Flue

Flue is **The Sandbox Agent Framework.** If you know how to use Claude Code (or OpenCode, Codex, Gemini, etc)... then you already know the basics of how to build agents with Flue.

A [Sandbox Agent](https://developers.openai.com/api/docs/guides/agents/sandboxes) pairs an **agent harness** (like Claude Code) with a secure, isolated container workspace. Sandbox Agents can edit files, write and execute code, spin up subagents, run terminal commands, and drive themselves autonomously to solve any given task. This pattern unlocks more powerful, intelligent agents that traditional AI frameworks wouldn't otherwise let you build.

Our take is that 1) any agent can be represented as a Sandbox Agent, and 2) any agent is _best_ represented as a Sandbox Agent. So we designed Flue to deliver on this vision.

## Packages

| Package                                   | Description                                |
| ----------------------------------------- | ------------------------------------------ |
| [`@flue/sdk`](packages/sdk)               | Core SDK: build system, sessions, tools    |
| [`@flue/cli`](packages/cli)               | CLI for building and running agents        |
| [`@flue/connectors`](packages/connectors) | Third-party connectors for sandboxes, etc. |

## Examples

### Quickstart

The simplest agent — no container, no tools, just a prompt and a typed result.

Unless you opt-in to initializing a full container sandbox, Flue will default to a virtual sandbox for every agent, powered by [just-bash](https://github.com/vercel-labs/just-bash). A virtual sandbox is going to be dramatically faster, cheaper, and more scalable than running a full container for every agent, which makes it perfect for building high-traffic/high-scale agents.

```ts
// .flue/agents/hello-world.ts
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

// Every agent needs a trigger. This agent is invoked as an API endpoint, via HTTP.
export const triggers = { webhook: true };

// The agent handler. Where the orchestration of the agent lives.
export default async function ({ init, payload }: FlueContext) {
  // `agent` -- Your initialized agent runtime including sandbox, tools, skills, etc.
  const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
  const session = await agent.session();

  // prompt() sends a message in the session, triggering action.
  const result = await session.prompt(`Translate this to ${payload.language}: "${payload.text}"`, {
    // Pass a result schema to get typed, schema-validated data back from your agent.
    result: v.object({
      translation: v.string(),
      confidence: v.picklist(['low', 'medium', 'high']),
    }),
  });

  return result;
}
```

### Support Agent

A support agent can also run in a virtual sandbox, but we now add a file-system using an R2 bucket. The knowledge base is stored in R2 and mounted directly into the agent's filesystem — the agent searches it with its built-in tools (grep, glob, read). Skills are also defined in the bucket that help the agent perform its task.

Because this agent is deployed to Cloudflare, message history and session state are automatically persisted for you. So you (or your customer) can revisit this support session days, weeks, or years later and pick up exactly where you left off.

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
  const agent = await init({ sandbox, model: 'openrouter/moonshotai/kimi-k2.6' });
  const session = await agent.session();

  return await session.prompt(
    `You are a support agent. Search the knowledge base for articles
    relevant to this request, then write a helpful response.

    Customer: ${payload.message}`,
    {
      // Provide roles (aka subagents) to guide your agent. Defined in .flue/roles/
      role: 'triager',
    },
  );
}
```

### Issue Triage (CI)

A triage agent that runs in CI whenever an issue is opened on GitHub. The `"local"` sandbox mounts the host filesystem and lets you connect privileged CLIs (`gh`, `npm`, `git`) to the agent without leaking secrets.

```ts
// .flue/agents/triage.ts
import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

// Because we are running this in CI, we don't need to expose this as an HTTP endpoint.
// The CLI can run any agent from the command line, `flue run triage ...`
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
  //
  // `model` sets the default model for every prompt/skill call in this
  // agent. Override per-call with `{ model: '...' }` on prompt()/skill().
  const agent = await init({
    sandbox: 'local',
    model: 'anthropic/claude-opus-4-7',
  });
  const session = await agent.session();

  // Skills can be referenced either by their frontmatter `name:` (shown below)
  // or by a relative path under `.agents/skills/` — e.g.
  // `session.skill('triage/reproduce.md', ...)`. Path references are handy for
  // skill packs that group multiple stages under one directory.
  const result = await session.skill('triage', {
    // Pass arguments to any prompt or skill.
    args: { issueNumber: payload.issueNumber },
    // Grant access to `gh` and `npm` for the life of this skill.
    commands: [gh, npm],
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
  // Each agent gets a real container via Daytona. The container has
  // a full Linux environment with persistent filesystem and shell.
  //
  // For simplicity, we always create a new sandbox here. You could also
  // first check for an existing sandbox for the agent id, and reuse that
  // instead to best pick up where you last left off in the conversation.
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  const agent = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
    model: 'openai/gpt-5.5',
  });
  const session = await agent.session();

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

## Agents And Sessions

Every agent invocation runs inside an initialized agent runtime. For HTTP agents, the agent ID is the last path segment:

```txt
POST /agents/<agent-name>/<id>
```

By default, `agent.session()` opens the default session for that agent ID. Reuse the same agent ID to continue the same default conversation. Use a new agent ID to start fresh.

```bash
# Start a conversation
curl http://localhost:8787/agents/hello/session-abc \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'

# Continue that conversation
curl http://localhost:8787/agents/hello/session-abc \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'

# Start a separate conversation
curl http://localhost:8787/agents/hello/session-xyz \
  -H "Content-Type: application/json" \
  -d '{"name": "Alice"}'
```

Agents own sandbox state such as files written during a run. Sessions persist message history and conversation metadata inside an agent. On Cloudflare, session data is backed by Durable Objects and survives across requests. On Node.js, sessions are stored in memory by default unless you provide a custom store.

In production, generate a stable agent ID for the sandbox/runtime scope you want to preserve. Use `agent.session(threadId)` when you need multiple conversations inside the same agent.

### Custom Virtual Sandboxes

For most agents, use the built-in virtual sandbox or `sandbox: 'local'`. If you need to customize just-bash directly, pass a Bash factory. The factory must return a fresh Bash-like runtime each time; share the filesystem object in the closure to persist files across sessions and prompts.

```ts
import { Bash, InMemoryFs } from 'just-bash';

const fs = new InMemoryFs();

const agent = await init({
  sandbox: () => new Bash({ fs, cwd: '/workspace', python: true }),
  model: 'anthropic/claude-sonnet-4-6',
});
const session = await agent.session();
```

## Running Agents

### Trigger From the CLI

Build and run any agent locally, perfect for fast local testing or running in CI.

```bash
flue run hello --target node --id test-1 \
  --payload '{"text": "Hello world", "language": "French"}'
```

### Trigger From HTTP Endpoint

Build and deploy your agents as a web server, perfect for hosted agents.

`flue build` builds to a `./dist` directory, which you can then deploy anywhere. Cloudflare and any Node.js host are supported today, with more coming in the future.

```
flue build --target node          # Node.js server
flue build --target cloudflare    # Cloudflare Workers + Durable Objects
```
