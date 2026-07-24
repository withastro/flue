---
title: Deploy Agents on Node.js
description: Build and deploy Flue agents as a Node.js server with Vite.
lastReviewedAt: 2026-07-21
---

Build and deploy Flue agents as a Node.js server. This guide walks you through creating your first agent, running it locally, and deploying it anywhere you can run Node.js — a VPS, Docker, Railway, Fly.io, or any cloud platform.

By the end, you will have a Flue agent running as a Node.js server, and you will know how to add subagents, sandbox context, external CLIs, remote sandboxes, and durable session storage when your agent needs them.

Flue is a Vite plugin: `vite dev` serves the application locally and `vite build` produces the deployable server artifact. First review [Routing](/docs/guide/routing/) for how `app.ts` mounts agent routes and how server code can `dispatch(...)` into agents. To package the server as a container image, see [Deploy Agents with Docker](/docs/ecosystem/deploy/docker/).

## Hello World

The simplest agent — no container, no storage, just a prompt and a reply.

### 1. Set up your project

```bash
mkdir my-flue-server && cd my-flue-server
npm init -y
npm install @flue/runtime hono valibot
npm install -D @flue/vite @flue/cli vite
```

Add the Vite plugin:

```ts title="vite.config.ts"
import { flue } from '@flue/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [flue()],
});
```

And the scripts:

```jsonc title="package.json"
{
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
  },
}
```

### 2. Create your first agent

An agent module is an ordinary TypeScript file plus one line: the `'use agent'` directive. The directive is how an agent joins the application — the build scans your source root for marked modules, every exported function with a capitalized name is an agent, and the function's name becomes the agent's durable identity (an optional `Translator.agentName = '...'` string-literal static overrides it).

```typescript title="src/agents/translator.ts"
'use agent';
import { useModel } from '@flue/runtime';

export function Translator() {
  useModel('openai/gpt-5.5');
  return 'Translate the user message into the requested language. Reply with the translation only.';
}
```

Agents that need a filesystem can attach an in-memory [virtual sandbox](/docs/guide/sandboxes/#the-virtual-sandbox) powered by [just-bash](https://github.com/vercel-labs/just-bash) — no container needed.

### 3. Create app.ts — the route map

`app.ts` is the only required file. Its default export owns the request pipeline, and every route is mounted explicitly — `app.ts` IS the routing table:

```typescript title="src/app.ts"
import { createAgentRouter } from '@flue/runtime/routing';
import { Hono } from 'hono';
import { Translator } from './agents/translator.ts';

const app = new Hono();

app.route('/agents/translator', createAgentRouter(Translator));
app.get('/api/ping', (c) => c.text('pong'));

export default app;
```

`createAgentRouter(Translator)` is a pure router factory: the mount path is yours to choose, and per-agent middleware is plain Hono at the mount (`app.use('/agents/translator/*', <middleware>)` before the `app.route(...)` line) to authenticate requests before they reach the agent. See [Routing](/docs/guide/routing/).

### 4. Add your API key

Put provider API keys in a `.env` file at the project root:

```bash
cat > .env <<'EOF'
OPENAI_API_KEY="your-api-key"
EOF

printf '\n.env\n' >> .gitignore
```

Use the env var name your provider expects — `OPENAI_API_KEY` for OpenAI, `ANTHROPIC_API_KEY` for Anthropic, and so on. Do not commit `.env`.

### 5. Run it

For local development, `vite dev` serves `app.ts` with hot reload, loading your `.env` automatically (shell-exported values win):

```bash
npx vite dev
```

Talk to the agent over HTTP. A conversation lives at the mount path plus any id you choose; the `POST` returns `202` immediately and the reply lands in the conversation:

```bash
curl -X POST 'http://localhost:5173/agents/translator/demo-1' \
  -H "Content-Type: application/json" \
  -d '{"kind": "user", "body": "Translate to French: Hello world"}'

# read the conversation (the reply appears once the agent settles)
curl 'http://localhost:5173/agents/translator/demo-1'
```

Application code should use the [Flue Agent SDK](/docs/sdk/overview/) instead of raw curl — `createFlueClient({ url }).send(...)` plus `wait()`/`observe()` handles admission and streaming for you.

For a one-shot local check without any server, `flue run` executes the agent module directly — transport-free, no port:

```bash
npx flue run src/agents/translator.ts --message "Translate to French: Hello world"
```

### 6. Build for production

```bash
npx vite build
set -a; source .env; set +a
node dist/server.mjs
```

`vite build` compiles your project into `./dist/server.mjs` without packaging `.env` credentials into the server; the built server reads only the environment supplied when you start it. It uses [Hono](https://hono.dev/) under the hood and listens on port 3000 by default (configurable via `PORT`). Your project's `node_modules` are still needed at runtime — the build externalizes your dependencies rather than bundling them.

To verify the artifact before deploying, `vite preview` serves the built application (it imports `dist/app.mjs` directly, with production behavior), or run it for real with `node dist/server.mjs`.

## Deterministic tool calls

For structured, schema-validated work inside the conversation, give the agent a harness-connected tool with `useTool({ harness: true })`: `run` receives the agent's runtime (sandbox and model access) and can call back into the model for sub-tasks.

```typescript title="src/agents/reporter.ts"
'use agent';
import { useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

export function Reporter() {
  useModel('openai/gpt-5.5');
  useTool({
    name: 'compile-report',
    description: 'Compile the weekly metrics report.',
    input: v.object({ period: v.string() }),
    harness: true,
    async run({ harness, data }) {
      const response = await harness.prompt(`Compile the metrics report for ${data.period}.`, {
        result: v.object({ summary: v.string() }),
      });
      return response.data;
    },
  });
  return 'When asked for a report, call the `compile-report` tool.';
}
```

Drive it with `flue run src/agents/reporter.ts --message "Compile the weekly report."`, a `dispatch()` from server code, or the SDK.

## Subagents

`useSubagent(...)` declares a named delegate the model can hand focused work to via a task:

```typescript title="src/agents/reporter.ts"
'use agent';
import { useModel, useSubagent } from '@flue/runtime';

function Analyst() {
  return 'Focus on quantitative insights, trends, and actionable takeaways.';
}

export function Reporter() {
  useSubagent({
    name: 'analyst',
    description: 'Analyzes metrics for quantitative insights and actionable takeaways.',
    agent: Analyst,
  });
  return 'Delegate metric analysis to the `analyst` subagent via a task.';
}
```

## Sandbox context

The agent reads `AGENTS.md` and skills from its sandbox at runtime. With `local()`, that's your real project root, so any files there are visible. With the virtual sandbox the filesystem starts empty — you'd set up context via `harness.sandbox`. Agents without a sandbox skip workspace discovery entirely.

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/summarize/SKILL.md`:

```markdown
---
name: summarize
description: Summarize a document or text input.
---

Given the text provided in the arguments, produce a concise summary.
Focus on the key points and keep it to 2-3 sentences.
```

**`AGENTS.md`** at the root of the sandbox is the agent's system prompt — it provides global context about the project.

Direct a skill from an Action or tool body with `harness.prompt(...)` — it shares the agent's own conversation context, so naming the skill is enough for the model to activate it:

```typescript
import * as v from 'valibot';

const { data } = await harness.prompt(`Apply the summarize skill to this text:\n\n${document}`, {
  result: v.object({ summary: v.string() }),
});
```

## Using the local sandbox

`local()` is where Node really shines compared to other targets. The agent runs directly against the host filesystem and shell — `cwd` is `process.cwd()`, shell commands go through `child_process`, and `AGENTS.md` and skills are discovered from the project root.

Run flue itself inside an isolation boundary you trust — a CI runner, a container, a sandbox VM. There is no second layer of isolation between the agent and the host.

Env exposure is opt-in. By default only shell essentials (`PATH`, `HOME`, locale, etc.) are inherited from `process.env`; anything else — API keys, tokens, deploy credentials — has to be passed explicitly via `local({ env: { ... } })`. That keeps the model's `bash` tool from seeing host secrets by accident.

```typescript title="src/agents/reviewer.ts"
'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function Reviewer() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  return 'Review the codebase and identify potential issues in the area the user names.';
}
```

The agent reads, searches, and modifies files via its built-in tools — read, write, edit, grep, glob, bash. Anything on `$PATH` (`git`, `npm`, `gh`, `docker`) is reachable from the bash tool. Env vars are opt-in via `local({ env: { ... } })` — pass `process.env.GH_TOKEN`, `process.env.NPM_TOKEN`, etc. into the sandbox for the binaries that need them.

### When to use it

- **Self-hosted coding agents** — review PRs, fix bugs, refactor against the actual repo.
- **File processing** — read documents, transform data, generate reports from local files.
- **Dev tooling** — analyze project structure, run linters, generate boilerplate.
- **CI** — issue triage, deploy checks, anything where the runner already provides isolation. `flue run` is a natural fit here: one agent, one message, no port.

No container startup, real project context, fast iteration. If you need a tighter boundary on a specific operation — agent can call it, never sees the underlying secret — wrap it as a custom tool via `useTool(...)` in the agent function. The tool reads `process.env`; the agent only sees the tool's params and result.

## Connecting a remote sandbox

The examples above use either the virtual sandbox or the local sandbox. When you need full isolation per session — each user gets their own Linux environment with git, Node.js, Python, etc. — you want a remote sandbox.

Flue connects to remote sandboxes through project-owned sandbox adapters installed from `flue add` blueprints. Run `flue add` with no arguments to see what's currently supported, or `flue add sandbox <url>` to have your coding agent build an adapter for an unsupported provider against the [Sandbox Adapter API](/docs/reference/sandbox-api/).

The Ecosystem catalog lists available provider integrations, including [Daytona](/docs/ecosystem/sandboxes/daytona/), [E2B](/docs/ecosystem/sandboxes/e2b/), [Modal](/docs/ecosystem/sandboxes/modal/), and [Vercel Sandbox](/docs/ecosystem/sandboxes/vercel/). Other adapters follow the same application-owned lifecycle shape.

### When to use a remote sandbox

The **local and virtual sandboxes** start in milliseconds; the local sandbox shares the host filesystem, and neither gives per-session isolation — a fit for single-tenant use and CI. A **remote sandbox** takes seconds to start (cached images are faster) and gives each session its own fully isolated environment, which multi-tenant and SaaS deployments need.

Start with the local or virtual sandbox. Move to a remote sandbox when you need per-session isolation.

## Conversation persistence

On Node.js, canonical agent conversations, attachments, and accepted submissions use in-memory SQLite by default in the built server, so they persist for the lifetime of one process but are lost on restart. (`vite dev` points the same default at a local disk file so history survives reloads within a dev session.) Add `db.ts` when that state must survive restart or support replacement recovery. A shared database does not remove the requirement for one live Node owner per agent instance.

See [Database](/docs/guide/database/) for `db.ts`, SQLite, Postgres, and custom adapter setup. See [Data Persistence API](/docs/reference/data-persistence-api/) for the adapter contract.

## Building and deploying

Flue compiles your project into a Node.js server:

```bash
# Build
npx vite build

# Run locally
node dist/server.mjs

# Run on a custom port
PORT=8080 node dist/server.mjs
```

The built server never runs in local dev mode: developer-only error guidance and the dev SQLite file are wired only through `vite dev`, not through environment variables.

The deployed server exposes exactly the routes `app.ts` mounts. For each mounted agent, relative to its mount:

- `POST /:id` — deliver a message into a conversation (`202` admission);
- `GET /:id` — read the conversation (materialized history or live updates via the Durable Streams protocol);
- `POST /:id/abort` — abort in-flight and queued work.

Flue does not add a health endpoint or inspection routes by default. Define a host-required health route in `app.ts` and compose any operator endpoints behind your own authorization. See [Routing](/docs/guide/routing/).

### Choosing a sandbox strategy

Here's the progression of sandbox types available on Node.js, from simplest to most powerful:

1. **Empty virtual sandbox** — an agent function with just `useModel(...)`. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `harness.sandbox` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **Local sandbox** — `useSandbox(local())` in the agent function. Direct host filesystem and shell access. Ideal for self-hosted agents, CI tasks, and dev tooling — anywhere the host environment already provides isolation. Import `local` from `@flue/runtime/node` and pass `env: { ... }` to expose specific host env vars to the agent's shell.
4. **Remote sandbox** — Full isolated Linux environment via a sandbox adapter. For multi-tenant agents, coding sandboxes, and anything that needs per-session isolation.

Start simple. Move up when you need to.
