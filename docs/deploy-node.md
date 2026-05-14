# Deploy Agents on Node.js

Build and deploy Flue agents as a Node.js server. This guide walks you through creating your first agent, running it locally, and deploying it anywhere you can run Node.js — a VPS, Docker, Railway, Fly.io, or any cloud platform.

By the end, you will have a Flue agent running as a Node.js server, and you will know how to add roles, sandbox context, external CLIs, remote sandboxes, and durable session storage when your agent needs them.

## Project layout

The project root is your project directory. Source files (agents, roles, and any other code your agents import) live in one of two places, analogous to Next.js's `src/` folder:

- `./agents/`, `./roles/` — bare layout, source at the project root.
- `./.flue/agents/`, `./.flue/roles/` — `.flue/` source layout. When you opt into this, treat `.flue/` as the home for everything agent-related (connectors, session stores, helpers, …).

If `./.flue/` exists, Flue reads sources from there; otherwise it reads from the project root. The two layouts never mix. By default `flue build` writes to `./dist/` at the project root; pass `--output <path>` to redirect the build elsewhere. Examples in this guide use the `./.flue/` layout — drop the prefix if you prefer the bare layout.

## Hello World

The simplest agent — no container, no storage, just a prompt and a typed result.

### 1. Set up your project

```bash
mkdir my-flue-server && cd my-flue-server
npm init -y
npm install @flue/runtime valibot
npm install -D @flue/cli
```

### 2. Create your first agent

`.flue/agents/translate.ts`:

```typescript
import type { FlueContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const harness = await init({ model: 'openai/gpt-5.5' });
  const session = await harness.session();

  const { data } = await session.prompt(`Translate this to ${payload.language}: "${payload.text}"`, {
    schema: v.object({
      translation: v.string(),
      confidence: v.picklist(['low', 'medium', 'high']),
    }),
  });

  return data;
}
```

A few things to note:

- **`triggers = { webhook: true }`** — This agent is invoked via HTTP. Flue creates a route for it automatically.
- **`init({ model })`** — Every agent needs a model. If you do not pass one, no model is chosen and `prompt()` / `skill()` calls will fail. By default, Flue gives every agent a virtual sandbox powered by [just-bash](https://github.com/vercel-labs/just-bash). No container needed.
- **Schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed.

### 3. Add your API key

Put provider API keys in a `.env` file at the project root:

```bash
cat > .env <<'EOF'
OPENAI_API_KEY="your-api-key"
EOF

printf '\n.env\n' >> .gitignore
```

Use the env var name your provider expects — `OPENAI_API_KEY` for OpenAI, `ANTHROPIC_API_KEY` for Anthropic, and so on. Do not commit `.env`.

### 4. Build and run

For local development, `flue dev --target node --env .env` is the fastest path. It builds your project root, loads the env file, starts the server on port 3583, and watches for changes — edit an agent file, the server reloads automatically.

```bash
npx flue dev --target node --env .env
```

Test it:

```bash
curl http://localhost:3583/agents/translate/test-1 \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

Every agent with `triggers = { webhook: true }` gets an HTTP endpoint automatically. The route follows the pattern `/agents/<name>/<id>` — for example, `.flue/agents/translate.ts` becomes `/agents/translate/:id`.

For a one-shot production-style run (no watcher), use `flue build` + the generated server. The built server reads `process.env` directly, so source your env file in your shell or pass values explicitly:

```bash
npx flue build --target node
set -a; source .env; set +a
node dist/server.mjs
```

`flue build --target node` compiles your project into a `./dist` directory. The built server uses [Hono](https://hono.dev/) under the hood and listens on port 3000 by default (configurable via the `PORT` environment variable). Your project's `node_modules` are still needed at runtime — the build externalizes your dependencies rather than bundling them.

You can also invoke any agent from the CLI without starting a server. `flue run` accepts the same `--env` flag:

```bash
npx flue run translate --target node --id test-1 --env .env \
  --payload '{"text": "Hello world", "language": "French"}'
```

## Roles

Roles shape agent behavior across prompts. They live alongside your agents — under `./roles/` (or `./.flue/roles/` if you use the `.flue/` layout) — and ship with the deployed server:

`.flue/roles/analyst.md`:

```markdown
---
description: A data analyst focused on extracting insights
---

You are a data analyst. Focus on quantitative insights, trends, and
actionable takeaways. Be precise with numbers and cite your sources.
```

Use a role by passing its name to `prompt()`:

```typescript
const analysis = await session.prompt("Analyze this quarter's metrics", {
  role: 'analyst',
});
```

## Sandbox context

The agent reads `AGENTS.md` and skills from its sandbox at runtime. With `local()`, that's your real project root, so any files there are visible. With the default virtual sandbox the filesystem starts empty — you'd set up context via `session.shell()` or skip these features for simple prompt-and-response agents.

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

Call a skill from your agent:

```typescript
import * as v from 'valibot';

const { data } = await session.skill('summarize', {
  args: { text: document },
  schema: v.object({ summary: v.string() }),
});
```

## Using the local sandbox

`local()` is where Node really shines compared to other targets. The agent runs directly against the host filesystem and shell — `cwd` is `process.cwd()`, shell commands go through `child_process`, and `AGENTS.md` and skills are discovered from the project root.

Run flue itself inside an isolation boundary you trust — a CI runner, a container, a sandbox VM. There is no second layer of isolation between the agent and the host.

Env exposure is opt-in. By default only shell essentials (`PATH`, `HOME`, locale, etc.) are inherited from `process.env`; anything else — API keys, tokens, deploy credentials — has to be passed explicitly via `local({ env: { ... } })`. That keeps the model's `bash` tool from seeing host secrets by accident.

`.flue/agents/reviewer.ts`:

```typescript
import type { FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const harness = await init({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' });
  const session = await harness.session();

  const { data } = await session.prompt(
    `Review the codebase and identify potential issues in the area
    related to: ${payload.topic}`,
    {
      role: 'reviewer',
      schema: v.object({
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

  return data;
}
```

The agent reads, searches, and modifies files via its built-in tools — read, write, edit, grep, glob, bash. Anything on `$PATH` (`git`, `npm`, `gh`, `docker`) is reachable from the bash tool. Env vars are opt-in via `local({ env: { ... } })` — pass `process.env.GH_TOKEN`, `process.env.NPM_TOKEN`, etc. into the sandbox for the binaries that need them.

### When to use it

- **Self-hosted coding agents** — review PRs, fix bugs, refactor against the actual repo.
- **File processing** — read documents, transform data, generate reports from local files.
- **Dev tooling** — analyze project structure, run linters, generate boilerplate.
- **CI** — issue triage, deploy checks, anything where the runner already provides isolation.

No container startup, real project context, fast iteration. If you need a tighter boundary on a specific operation — agent can call it, never sees the underlying secret — wrap it as a custom tool via `init({ tools: [...] })`. The tool reads `process.env`; the agent only sees the tool's params and result.

## Connecting a remote sandbox

The examples above use either the default virtual sandbox or the local sandbox. When you need full isolation per session — each user gets their own Linux environment with git, Node.js, Python, etc. — you want a remote sandbox.

Flue connects to remote sandboxes through small adapter files called connectors, installed with `flue add`. Run `flue add` with no arguments to see what's currently supported, or `flue add <url> --category sandbox` to have your coding agent build a connector for an unsupported provider against the [sandbox connector spec](./sandbox-connector-spec.md).

We've written a full walkthrough for one provider — [Connect a Daytona Sandbox](./connect-daytona.md) — that covers installing the connector, wiring it into an agent, and configuring the sandbox. Other connectors follow the same shape.

### When to use a remote sandbox

| Local / virtual sandbox        | Remote sandbox                              |
| ------------------------------ | ------------------------------------------- |
| Millisecond startup            | Seconds to start (cached images are faster) |
| Shares host filesystem (local) | Fully isolated per session                  |
| No per-session isolation       | Each user gets their own environment        |
| Great for single-tenant / CI   | Great for multi-tenant / SaaS               |

Start with the local or virtual sandbox. Move to a remote sandbox when you need per-session isolation.

## Session persistence

On Node.js, session state is stored in memory by default — sessions persist for the lifetime of the process but are lost on restart. This is fine for development and stateless workloads.

For durable sessions, pass a custom store via the `persist` option on `init()`. A store implements three methods — `save()`, `load()`, and `delete()` — each operating on a session ID and a `SessionData` object (message history, metadata, compaction state):

```typescript
import type { FlueContext, SessionStore, SessionData } from '@flue/runtime';
import { local } from '@flue/runtime/node';

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
  const harness = await init({
    sandbox: local(),
    persist: store,
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await harness.session();
  // ...
}
```

You can back this with any database: SQLite, Postgres, Redis, etc.

## Building and deploying

Flue compiles your project into a Node.js server:

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
3. **Local sandbox** — `init({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' })`. Direct host filesystem and shell access. Ideal for self-hosted agents, CI tasks, and dev tooling — anywhere the host environment already provides isolation. Import `local` from `@flue/runtime/node` and pass `env: { ... }` to expose specific host env vars to the agent's shell.
4. **Remote sandbox** — Full isolated Linux environment via a sandbox connector. For multi-tenant agents, coding sandboxes, and anything that needs per-session isolation.

Start simple. Move up when you need to.
