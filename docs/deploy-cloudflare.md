# Deploy Agents on Cloudflare

Build and deploy Flue agents on Cloudflare Workers. This guide walks you through the different kinds of agents you can build — from simple prompt-and-response endpoints to full coding agents backed by persistent storage and container sandboxes.

## Project layout

Flue looks for your workspace in one of two places:

- `./` — agents in `./agents/`, roles in `./roles/`.
- `./.flue/` — agents in `./.flue/agents/`, roles in `./.flue/roles/`.

If `./.flue/` exists, Flue uses it. Otherwise it uses the project root. Examples in this guide use the `./.flue/` layout — drop the prefix if you prefer the root.

## Hello World

The simplest agent — no container, no storage, just a prompt and a typed result.

### 1. Set up your project

```bash
mkdir my-flue-worker && cd my-flue-worker
npm init -y
npm install @flue/sdk valibot agents
npm install -D @flue/cli wrangler
```

`agents` is Cloudflare's Agents SDK — Flue uses it to route HTTP requests to a per-agent Durable Object. If you also need container sandboxes, additionally install `@cloudflare/sandbox` (see [Container agents](#container-agents) below).

### 2. Create your first agent

`.flue/agents/translate.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
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
- **`init({ model })`** — Every session needs a model. If you do not pass one, no model is chosen and `prompt()` / `skill()` calls will fail. By default, Flue gives every agent a virtual sandbox powered by [just-bash](https://github.com/vercel-labs/just-bash). No container needed.
- **Result schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns a typed object.

### 3. Build and deploy

```bash
npx flue build --target cloudflare
npx wrangler deploy
```

`flue build --target cloudflare` compiles your workspace into a `./dist` directory containing a Cloudflare Workers-compatible artifact. `wrangler deploy` pushes it live.

### 4. Add your API key

Put provider API keys in a `.env` file at the project root:

```bash
cat > .env <<'EOF'
ANTHROPIC_API_KEY="your-api-key"
EOF

printf '\n.env\n' >> .gitignore
```

Use the env var name your provider expects — `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. Do not commit `.env`.

Pass the file explicitly with `--env <path>`. Flue loads it for both `flue dev` and `flue run` (the same flag works for Node and Cloudflare targets):

```bash
npx flue dev --target cloudflare --env .env
```

For deploying, Wrangler reads the same file:

```bash
npx flue build --target cloudflare
npx wrangler deploy --secrets-file .env
```

> **Note on `.dev.vars`.** Wrangler's docs use `.dev.vars` as the convention for local secrets. The format is identical to `.env`, and you can call your file whatever you like — Flue just needs a path. We use `.env` in these examples because it's the broader Node/Web convention and works the same way regardless of which target you're using.

### 5. Try it locally

For local development, use `flue dev --target cloudflare`. It builds your workspace, then starts a Cloudflare Workers dev server (via wrangler) on port 3583 and watches for changes:

```bash
npx flue dev --target cloudflare --env .env
```

Then test it:

```bash
curl http://localhost:3583/agents/translate/test-1 \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

`flue run` starts the generated server in Node.js, so it only supports `--target node`. Cloudflare builds use Worker-only runtime modules — `flue dev --target cloudflare` is the equivalent for testing them locally.

## Roles

Roles shape agent behavior across prompts. They live alongside your agents — under `./roles/` (or `./.flue/roles/` if you use the `.flue/` layout) — and ship with your deployed worker:

`.flue/roles/triager.md`:

```markdown
---
description: A support agent that triages customer requests
---

You are a support triager. Search the knowledge base thoroughly before
responding. Always cite the specific articles you referenced. Be empathetic
but concise.
```

Use a role by passing its name to `prompt()`:

```typescript
const response = await session.prompt('Help me reset my password', {
  role: 'triager',
});
```

## Using the sandbox

By default, the virtual sandbox starts empty — no files, no skills, no context. This is fine for stateless prompt-and-response agents like the translator above. But many agents need files to work with.

Because the agent has shell access, it can set up its own workspace on the fly:

```typescript
import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ model: 'openai/gpt-5.5' });
  const session = await agent.session();

  // The agent has a full virtual filesystem and shell.
  // Set up context files before prompting.
  await session.shell(`mkdir -p /workspace/data`);
  await session.shell(`cat > /workspace/data/config.json << 'EOF'
{
  "rules": ["Be concise", "Use bullet points", "Cite sources"],
  "tone": "professional"
}
EOF`);

  return await session.prompt(
    `Read the config in /workspace/data/config.json.
     Generate a report about: ${payload.topic}`,
  );
}
```

The agent can use its built-in tools — grep, glob, read — to search and read these files. This is still running on a virtual sandbox (no container), so it's fast and cheap.

## R2-backed agents

Inline files work for small, static content. But for larger datasets — a knowledge base, documentation corpus, product catalog — you want persistent storage. Flue integrates with [Cloudflare R2](https://developers.cloudflare.com/r2/) to mount a bucket directly as the agent's filesystem.

### The support agent pattern

This is one of the most powerful patterns on Cloudflare: a support agent that searches a knowledge base to answer customer questions. The knowledge base lives in R2, and Flue mounts it as the sandbox filesystem — the agent searches it with grep, glob, and read, just like a real filesystem.

`.flue/agents/support.ts`:

```typescript
import { getVirtualSandbox } from '@flue/sdk/cloudflare';
import type { FlueContext } from '@flue/sdk/client';

export const triggers = { webhook: true };

export default async function ({ init, payload, env }: FlueContext) {
  const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
  const agent = await init({ sandbox, model: 'openrouter/moonshotai/kimi-k2.6' });
  const session = await agent.session();

  return await session.prompt(
    `You are a support agent. Search the knowledge base for articles
    relevant to this request, then write a helpful response.

    Customer: ${payload.message}`,
    {
      role: 'triager',
    },
  );
}
```

### Adding the R2 binding

Add the R2 bucket to your project's `wrangler.jsonc` (at the root of your project, alongside `package.json`):

```jsonc
{
  "name": "my-support-agent",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "r2_buckets": [
    {
      "binding": "KNOWLEDGE_BASE",
      "bucket_name": "my-knowledge-base",
    },
  ],
}
```

When you run `flue build --target cloudflare`, Flue merges its own Durable Object bindings into this file and writes the composed config to `dist/wrangler.jsonc`. `wrangler deploy` picks that up automatically via a redirect at `.wrangler/deploy/config.json` — so you can keep editing only your root `wrangler.jsonc` and bindings like this R2 binding will flow through to deploy. You don't need to set `main` yourself; Flue owns the bundle entrypoint.

Upload your knowledge base to R2 using Wrangler:

```bash
# Upload individual files
wrangler r2 object put my-knowledge-base/articles/getting-started.md --file ./docs/getting-started.md

# Or upload a directory
for f in ./docs/**/*.md; do
  key="articles/${f#./docs/}"
  wrangler r2 object put "my-knowledge-base/$key" --file "$f"
done
```

### Why this works well

- **No container** — Still running on a virtual sandbox. Fast startup, low cost.
- **Persistent data** — The knowledge base lives in R2 and persists across requests.
- **Agent-native search** — The agent uses grep and glob to find relevant articles, just like it would in a real filesystem.
- **Session persistence** — Because this deploys to Cloudflare Workers with Durable Objects, message history and session state are automatically persisted. A customer can revisit a support session days later and pick up where they left off.

## Container agents

The examples above all run on virtual sandboxes — no container needed. But for agents that need a full Linux environment — git, Node.js, a browser, system packages — you want a real container.

Cloudflare has native container support via [`@cloudflare/sandbox`](https://developers.cloudflare.com/containers/). Each session gets its own isolated container with a persistent filesystem, shell, and full Linux userspace.

### Setup

You own the container config. That means three things:

1. Install `@cloudflare/sandbox`: `npm install @cloudflare/sandbox`.
2. Declare the Durable Object binding, migration, and container image in your `wrangler.jsonc` at the project root.
3. Commit a `Dockerfile` at the path your `containers[].image` points to.

Flue automates one piece: **any DO binding whose `class_name` ends with `Sandbox` is automatically wired up as `@cloudflare/sandbox`'s `Sandbox` class in the generated Worker bundle.** Pick any name you want (`Sandbox`, `PyBoxSandbox`, `SupportSandbox`, …) and Flue handles the re-export.

### Example

`wrangler.jsonc` (at the project root, alongside `package.json`):

```jsonc
{
  "$schema": "https://workers.cloudflare.com/schema/wrangler.json",
  "name": "my-agent",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
  "containers": [{ "class_name": "Sandbox", "image": "./Dockerfile" }]
}
```

`Dockerfile` (at the project root):

```dockerfile
FROM docker.io/cloudflare/sandbox:0.9.2
```

The base image is published by Cloudflare and bundles the control-plane HTTP server that `@cloudflare/sandbox` needs to communicate with the container, along with `node`, `git`, `curl`, and a working directory at `/workspace`. Pin the tag to match the `@cloudflare/sandbox` version in your `package.json` — they're versioned together. Add your own `RUN` lines to install extra tools as needed.

`.flue/agents/assistant.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import { getSandbox } from '@cloudflare/sandbox';

export const triggers = { webhook: true };

export default async function ({ init, id, env, payload }: FlueContext) {
  // The binding name you chose in wrangler.jsonc is the key on `env`.
  const sandbox = getSandbox(env.Sandbox, id);
  const agent = await init({ sandbox, model: 'anthropic/claude-opus-4-7' });
  const session = await agent.session();

  return await session.prompt(payload.message);
}
```

### Multiple sandboxes

Different agents can use different container images. Declare a separate binding for each (each `class_name` must contain `Sandbox`), and give each its own container entry:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "class_name": "PyBoxSandbox", "name": "PyBox" },
      { "class_name": "NodeSandbox", "name": "NodeBox" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["PyBoxSandbox", "NodeSandbox"] }
  ],
  "containers": [
    { "class_name": "PyBoxSandbox", "image": "./docker/python.Dockerfile" },
    { "class_name": "NodeSandbox", "image": "./docker/node.Dockerfile" }
  ]
}
```

Each agent grabs the sandbox it needs: `getSandbox(env.PyBox, id)` or `getSandbox(env.NodeBox, id)`.

### Secure egress with outbound Workers

When your agent runs in a container, it may need to call external APIs — GitHub, npm registries, internal services. The traditional approach is to inject API tokens as environment variables, but that means the agent (and the LLM) has direct access to those secrets.

Cloudflare Sandboxes solve this with [outbound Workers](https://blog.cloudflare.com/sandbox-auth/) — a programmable egress proxy that intercepts outgoing HTTP/HTTPS requests from the container. Secrets are injected at the proxy layer, so the container never sees them. This is configured on the Cloudflare Sandbox class, outside of your Flue agent code:

```typescript
class MySandbox extends Sandbox {
  static outboundByHost = {
    'api.github.com': (request, env, ctx) => {
      const headers = new Headers(request.headers);
      headers.set('Authorization', `Bearer ${env.GITHUB_TOKEN}`);
      return fetch(request, { headers });
    },
  };
}
```

This is a zero-trust model — no token is ever granted to the untrusted sandbox. The proxy runs on the same machine as the container, so latency is minimal. You can also use outbound Workers to log requests, block specific domains, or enforce dynamic policies that change over the lifetime of a session.

For full details, see the [outbound Workers documentation](https://developers.cloudflare.com/containers/platform-details/outbound-traffic/).

### When to use containers

| Virtual sandbox                  | Container sandbox                           |
| -------------------------------- | ------------------------------------------- |
| Millisecond startup              | Seconds to start (cached images are faster) |
| Grep, glob, read, basic shell    | Full Linux: git, Node.js, Python, browsers  |
| R2 or inline files               | Real persistent filesystem                  |
| High-traffic / high-scale agents | Coding agents, complex dev environments     |

Most agents don't need a container. Start with a virtual sandbox and only move to containers when you need the full environment.

## Session persistence

When deploying to Cloudflare, Flue uses Durable Objects to automatically persist session state — message history, context, and sandbox state all survive across requests. This means you can build conversational agents where users pick up exactly where they left off.

This is built in when you deploy with `--target cloudflare`. No extra configuration needed.

## Sandbox context

`AGENTS.md` and skills are optional workspace-context files that the agent reads from its sandbox at `init()` time. They live at conventional paths inside whatever sandbox the agent is using — Flue looks for `<cwd>/AGENTS.md` and `<cwd>/.agents/skills/<name>/SKILL.md`. Whatever's there gets loaded; whatever isn't, doesn't. Most agents don't need either to do useful work.

If you want to use them, put them in your sandbox. How you do that depends on which sandbox you're using: upload to R2 for an R2-backed virtual sandbox, `COPY` them in for a container, or write them in via `session.shell()` on a sandbox you control.

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/greet/SKILL.md`:

```markdown
---
name: greet
description: Generate a personalized greeting for a given name.
---

Given the name provided in the arguments, generate a warm, personalized
greeting. Keep it to one or two sentences.
```

**`AGENTS.md`** at the root of the sandbox is the agent's system prompt — it provides global context about the project.

```markdown
You are a helpful assistant working on the my-project codebase.
Use the project's existing patterns and conventions.
```

Call a skill from your agent:

```typescript
const greeting = await session.skill('greet', {
  args: { name: 'World' },
  result: v.object({ greeting: v.string() }),
});
```

## Building and deploying

Flue compiles your workspace into a deployable artifact. For Cloudflare, this means a Workers-compatible bundle:

```bash
# Local development (build + watch + dev server on port 3583)
npx flue dev --target cloudflare --env .env

# One-off build for Cloudflare
npx flue build --target cloudflare

# Deploy to production (Wrangler reads the same .env as a secrets bundle)
npx wrangler deploy --secrets-file .env
```

Every agent with `triggers = { webhook: true }` gets an HTTP endpoint automatically. The route follows the pattern `/agents/<name>/<id>` — for example, `.flue/agents/translate.ts` becomes `/agents/translate/:id`.

```bash
# Hit your deployed agent
curl https://my-support-agent.<your-subdomain>.workers.dev/agents/support/session-123 \
  -H "Content-Type: application/json" \
  -d '{"message": "How do I reset my password?"}'
```

### Choosing a sandbox strategy

Here's the progression of sandbox types available on Cloudflare, from simplest to most powerful:

1. **Empty virtual sandbox** — `init({ model: 'anthropic/claude-sonnet-4-6' })`. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `session.shell()` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **R2-backed virtual sandbox** — `getVirtualSandbox(env.BUCKET)`. Persistent storage, searchable filesystem. Ideal for knowledge bases, support agents, data processing.
4. **Container sandbox** — Full Linux environment via `@cloudflare/sandbox`. For coding agents, complex dev environments, and anything that needs real system tools.

Start simple. Move up when you need to.
