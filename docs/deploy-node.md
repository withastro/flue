# Deploy Agents on Node.js

Build and deploy Flue agents as a Node.js server. This guide walks you through creating your first agent, running it locally, and deploying it anywhere you can run Node.js — a VPS, Docker, Railway, Fly.io, or any cloud platform.

## Project layout

Flue looks for your workspace in one of two places:

- `./` — agents in `./agents/`, roles in `./roles/`.
- `./.flue/` — agents in `./.flue/agents/`, roles in `./.flue/roles/`.

If `./.flue/` exists, Flue uses it. Otherwise it uses the project root. Examples in this guide use the `./.flue/` layout — drop the prefix if you prefer the root.

## Hello World

The simplest agent — no container, no storage, just a prompt and a typed result.

### 1. Set up your project

```bash
mkdir my-flue-server && cd my-flue-server
npm init -y
npm install @flue/sdk valibot
npm install -D @flue/cli
```

### 2. Create your first agent

`.flue/agents/translate.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ model: 'openai/gpt-5.5' });
  const session = await agent.session();

  const result = await session.prompt(`Translate this to ${payload.language}: "${payload.text}"`, {
    result: v.object({
      translation: v.string(),
      confidence: v.picklist(['low', 'medium', 'high']),
    }),
  });

  return result;
}
```

A few things to note:

- **`triggers = { webhook: true }`** — This agent is invoked via HTTP. Flue creates a route for it automatically.
- **`init({ model })`** — Every agent needs a model. If you do not pass one, no model is chosen and `prompt()` / `skill()` calls will fail. By default, Flue gives every agent a virtual sandbox powered by [just-bash](https://github.com/vercel-labs/just-bash). No container needed.
- **Result schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns a typed object.

### 3. Build and run

For local development, `flue dev --target node` is the fastest path. It builds your workspace, starts the server on port 3583, and watches for changes — edit an agent file, the server reloads automatically.

```bash
OPENAI_API_KEY=sk-... npx flue dev --target node
```

Test it:

```bash
curl http://localhost:3583/agents/translate/test-1 \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

Every agent with `triggers = { webhook: true }` gets an HTTP endpoint automatically. The route follows the pattern `/agents/<name>/<id>` — for example, `.flue/agents/translate.ts` becomes `/agents/translate/:id`.

For a one-shot production-style run (no watcher), use `flue build` + the generated server:

```bash
npx flue build --target node
OPENAI_API_KEY=sk-... node dist/server.mjs
```

`flue build --target node` compiles your workspace into a `./dist` directory. The built server uses [Hono](https://hono.dev/) under the hood and listens on port 3000 by default (configurable via the `PORT` environment variable). Your project's `node_modules` are still needed at runtime — the build externalizes your dependencies rather than bundling them.

You can also invoke any agent from the CLI without starting a server:

```bash
npx flue run translate --target node --id test-1 \
  --payload '{"text": "Hello world", "language": "French"}'
```

## Skills and roles

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

**Roles** shape agent behavior across prompts. They live in `.flue/roles/`:

`.flue/roles/analyst.md`:

```markdown
---
description: A data analyst focused on extracting insights
---

You are a data analyst. Focus on quantitative insights, trends, and
actionable takeaways. Be precise with numbers and cite your sources.
```

The **`AGENTS.md`** file at the root of your workspace is the agent's system prompt — it provides global context about the project. Flue discovers this file automatically from the sandbox's working directory. With `sandbox: 'local'`, that's your real project root. With the default virtual sandbox, the filesystem starts empty so there's nothing to discover — you'd set up context via `session.shell()` or skip it entirely for simple prompt-and-response agents.

Use skills and roles in your agent:

```typescript
import * as v from 'valibot';

// Run a skill with arguments and a typed result
const summary = await session.skill('summarize', {
  args: { text: document },
  result: v.object({ summary: v.string() }),
});

// Use a role to shape behavior
const analysis = await session.prompt("Analyze this quarter's metrics", {
  role: 'analyst',
});
```

## Using the local sandbox

This is where Node.js really shines compared to other targets. The `'local'` sandbox mounts the host's `process.cwd()` at `/workspace`, giving the agent direct access to the real filesystem. Skills and `AGENTS.md` are discovered automatically from the workspace directory.

`.flue/agents/reviewer.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });
  const session = await agent.session();

  const result = await session.prompt(
    `Review the codebase and identify potential issues in the area
    related to: ${payload.topic}`,
    {
      role: 'reviewer',
      result: v.object({
        issues: v.array(
          v.object({
            file: v.string(),
            line: v.optional(v.number()),
            severity: v.picklist(['low', 'medium', 'high']),
            description: v.string(),
          }),
        ),
        summary: v.string(),
      }),
    },
  );

  return result;
}
```

The agent can read, search, and modify files using its built-in tools — read, write, edit, grep, glob, and bash. Because it's running against the real filesystem, it can do things like run tests, check build output, or inspect config files.

### When to use the local sandbox

- **Self-hosted coding agents** — An agent that reviews PRs, fixes bugs, or refactors code against the actual repo.
- **File processing** — An agent that reads documents, transforms data, or generates reports from local files.
- **Dev tooling** — An agent that analyzes your project structure, runs linters, or generates boilerplate.

The local sandbox is fast (no container startup) and gives the agent real context (your actual project files, `AGENTS.md`, skills). The tradeoff is that the agent shares the host filesystem — there's no isolation between sessions.

## Connecting external CLIs with commands

Your agent may need to interact with tools like `git`, `npm`, or `docker`. **Commands** let you connect privileged CLIs to the agent without leaking secrets.

`.flue/agents/deploy.ts`:

```typescript
import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

export const triggers = { webhook: true };

// Bare pass-through. Safe, non-sensitive env vars like PATH, HOME, LANG, and TZ
// are forwarded automatically — API keys and secrets stay on the host.
const git = defineCommand('git', { env: { GIT_AUTHOR_NAME: 'flue-bot' } });

// Opt the agent into a single privileged env var without exposing the rest
// of process.env.
const npm = defineCommand('npm', { env: { NPM_TOKEN: process.env.NPM_TOKEN } });

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ sandbox: 'local', model: 'anthropic/claude-opus-4-7' });
  const session = await agent.session();

  const result = await session.skill('deploy-check', {
    args: { branch: payload.branch },
    // Grant access to `git` and `npm` for the life of this skill.
    commands: [git, npm],
    result: v.object({
      ready: v.boolean(),
      blockers: v.array(v.string()),
    }),
  });

  return result;
}
```

`defineCommand(name)` and `defineCommand(name, { env })` shell out via `child_process.execFile` with a sensible default env. If you need full control over how the command runs (custom logic, a different binary, fine-grained env scrubbing), use the function form:

```typescript
const gh = defineCommand('gh', async (args) => {
  // Your own implementation — return the stdout/stderr/exitCode however you like.
  // Thrown errors are caught automatically and surfaced as a non-zero exit code.
  const res = await fetch('https://api.github.com/...');
  return { stdout: await res.text() };
});
```

Commands are granted per-prompt or per-skill, so you can be as granular with access as you need. If the agent tries to run `git` outside of a prompt where it was granted, the command is blocked.

### Agent-wide commands

If every call in an agent needs the same set of commands, pass them to `init()` once instead of to every `prompt()` / `skill()` / `shell()`:

```typescript
const agent = await init({
  sandbox: 'local',
  commands: [git, npm],
  model: 'openrouter/moonshotai/kimi-k2.6',
});
const session = await agent.session();

// `git` and `npm` are available here without repeating `commands: [...]`.
await session.skill('deploy-check', { args: { branch: payload.branch } });
await session.shell('git status');
```

Per-call `commands` still work and are merged on top of the agent list. If a per-call command shares a name with an agent command, the per-call version wins for that call only — the agent command is restored afterward.

## Container agents

The examples above use either the default virtual sandbox or the local sandbox. But when you need full isolation per session — each user gets their own Linux environment with git, Node.js, Python, etc. — you want a container sandbox.

Flue's `@flue/connectors` package provides integrations with container sandbox providers. Here's an example using [Daytona](https://www.daytona.io/):

`.flue/agents/code.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import { Daytona } from '@daytona/sdk';
import { daytona } from '@flue/connectors/daytona';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  const setupAgent = await init({
    sandbox: daytona(sandbox, { cleanup: true }),
    model: 'openai/gpt-5.5',
  });
  const setup = await setupAgent.session();

  await setup.shell(`git clone ${payload.repo} /workspace/project`);
  await setup.shell('npm install', { cwd: '/workspace/project' });

  const projectAgent = await init({
    id: 'project',
    sandbox: daytona(sandbox),
    cwd: '/workspace/project',
    model: 'openai/gpt-5.5',
  });
  const session = await projectAgent.session();

  return await session.prompt(payload.prompt);
}
```

Daytona is one of many possible sandbox providers. Any provider that implements Flue's `SandboxFactory` interface works — check `@flue/connectors` for available integrations, or implement your own.

### A note on secrets and container security

When your agent runs in a container sandbox, be aware that environment variables and mounted secrets are accessible to the LLM. If the agent is compromised or the model behaves unexpectedly, those secrets could be exfiltrated.

For virtual and local sandboxes, Flue's `defineCommand` pattern already solves this — secrets live in the host process and are never exposed to the sandbox. But for container sandboxes, the agent has a full Linux environment and can make arbitrary network requests.

Some container sandbox providers offer egress proxy features that let you inject credentials at the network level without exposing them to the container (for example, [Cloudflare Sandboxes](https://blog.cloudflare.com/sandbox-auth/) support this natively). If your workload handles sensitive secrets and you need egress protection, look for a provider that supports this. Daytona does not currently offer an equivalent feature.

### When to use containers

| Local / virtual sandbox        | Container sandbox                           |
| ------------------------------ | ------------------------------------------- |
| Millisecond startup            | Seconds to start (cached images are faster) |
| Shares host filesystem (local) | Fully isolated per session                  |
| No per-session isolation       | Each user gets their own environment        |
| Great for single-tenant / CI   | Great for multi-tenant / SaaS               |

Start with the local or virtual sandbox. Move to containers when you need per-session isolation.

## Session persistence

On Node.js, session state is stored in memory by default — sessions persist for the lifetime of the process but are lost on restart. This is fine for development and stateless workloads.

For durable sessions, pass a custom store via the `persist` option on `init()`. A store implements three methods — `save()`, `load()`, and `delete()` — each operating on a session ID and a `SessionData` object (message history, metadata, compaction state):

```typescript
import type { FlueContext, SessionStore, SessionData } from '@flue/sdk/client';

// Example: a simple file-backed store. In production, use a database.
const store: SessionStore = {
  async save(id: string, data: SessionData) {
    /* write to DB */
  },
  async load(id: string) {
    /* read from DB, return null if not found */
  },
  async delete(id: string) {
    /* delete from DB */
  },
};

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({
    sandbox: 'local',
    persist: store,
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await agent.session();
  // ...
}
```

You can back this with any database: SQLite, Postgres, Redis, etc.

## Building and deploying

Flue compiles your workspace into a Node.js server:

```bash
# Build
npx flue build --target node

# Run locally
node dist/server.mjs

# Run on a custom port
PORT=8080 node dist/server.mjs
```

The server exposes:

- `GET /health` — Health check
- `GET /agents` — Agent manifest (lists all agents and their triggers)
- `POST /agents/:name/:id` — Invoke an agent

### Deploying with Docker

```dockerfile
FROM node:22-slim
WORKDIR /app
# The build externalizes your dependencies, so node_modules
# are needed at runtime.
COPY package.json package-lock.json ./
RUN npm ci --production
COPY dist/ ./dist/
ENV PORT=8080
EXPOSE 8080
CMD ["node", "dist/server.mjs"]
```

```bash
docker build -t my-flue-server .
docker run -p 8080:8080 -e OPENAI_API_KEY=sk-... my-flue-server
```

### Deploying elsewhere

The output is just a Node.js server, so it runs anywhere:

- **systemd / PM2** — `pm2 start dist/server.mjs`
- **Railway / Render** — Point the start command at `node dist/server.mjs`
- **Fly.io** — Use the Dockerfile above with `fly launch`
- **AWS / GCP / Azure** — Deploy as a container or directly on a VM

### Choosing a sandbox strategy

Here's the progression of sandbox types available on Node.js, from simplest to most powerful:

1. **Empty virtual sandbox** — `init({ model: 'openai/gpt-5.5' })`. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `session.shell()` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **Local sandbox** — `init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' })`. Mounts the host filesystem at `/workspace`. Ideal for self-hosted agents, CI tasks, and dev tooling.
4. **Container sandbox** — Full isolated Linux environment via Daytona or other providers. For multi-tenant agents, coding sandboxes, and anything that needs per-session isolation.

Start simple. Move up when you need to.
