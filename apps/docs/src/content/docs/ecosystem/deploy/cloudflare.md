---
title: Deploy Agents on Cloudflare
description: Build and deploy Flue agents on Cloudflare Workers.
---

Build and deploy Flue agents on Cloudflare Workers. This guide walks you through the different kinds of agents you can build — from simple prompt-and-response endpoints to full coding agents backed by persistent storage and remote sandboxes.

By the end, you will have a Flue agent running on Cloudflare Workers, and you will know how to add subagents, R2-backed context, Cloudflare sandboxes, and Durable Object-backed sessions.

## Project layout

The project root is your project directory. Flue selects authored source from `.flue/`, then `src/`, then the project root. The first matching directory wins, and layouts never mix. See [Project Layout](/docs/guide/project-layout/) for the full convention.

By default `flue build` writes to `./dist/` at the project root; pass `--output <path>` to redirect the build elsewhere. `wrangler.jsonc` and any `Dockerfile` you ship live at the project root, regardless of where the build lands. Examples in this guide use the `./.flue/` layout.

## Hello World

The simplest agent — no container, no storage, just a prompt and a typed result.

### 1. Set up your project

```bash
mkdir my-flue-worker && cd my-flue-worker
npm init -y
npm install @flue/runtime valibot agents
npm install -D @flue/cli wrangler
```

`agents` is Cloudflare's Agents SDK — Flue uses it to route HTTP requests to a per-agent Durable Object. If you also need a remote sandbox, additionally install `@cloudflare/sandbox` (see [Connecting a remote sandbox](#connecting-a-remote-sandbox) below).

### 2. Create your first agent

`.flue/workflows/translate.ts`:

```typescript
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const translator = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(translator);
  const session = await harness.session();

  const { data } = await session.prompt(
    `Translate this to ${payload.language}: "${payload.text}"`,
    {
      result: v.object({
        translation: v.string(),
        confidence: v.picklist(['low', 'medium', 'high']),
      }),
    },
  );

  return data;
}
```

A few things to note:

- **`route`** — Export Hono middleware to expose this workflow via HTTP. It may perform authentication before calling `next()`.
- **`createAgent(...)` + `init(agent)`** — Created agents declare model and sandbox configuration; workflows initialize them only when needed. `init(agent)` fails unless its created agent config provides a model, sets `model: false`, or supplies a profile with a model. By default, Flue gives every agent a virtual sandbox powered by [just-bash](https://github.com/vercel-labs/just-bash). No container needed.
- **Schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed.

### 3. Configure Durable Object migrations

Cloudflare requires an explicit migration whenever a Worker adds a Durable Object class. Flue generates the classes and bindings for discovered agents and workflows, but your project owns the ordered migration history in `wrangler.jsonc`.

`wrangler.jsonc`:

```jsonc
{
  "$schema": "https://workers.cloudflare.com/schema/wrangler.json",
  "name": "my-flue-worker",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "TranslateWorkflow"] }],
}
```

Every Cloudflare target includes `FlueRegistry`. Workflow classes use the PascalCase filename plus `Workflow`, so `.flue/workflows/translate.ts` becomes `TranslateWorkflow`. Agent classes use the PascalCase filename directly, so `.flue/agents/support-chat.ts` becomes `SupportChat`.

Keep deployed migration entries in order. When you add an agent or workflow later, append a uniquely tagged migration for its new class. Use Cloudflare's explicit rename or delete migrations when changing a deployed class lifecycle.

### 4. Build and deploy

```bash
npx flue build --target cloudflare
npx wrangler deploy
```

`flue build --target cloudflare` compiles your project into a `./dist` directory containing a Cloudflare Workers-compatible artifact. `wrangler deploy` pushes it live.

### 5. Add your API key

For local Cloudflare development, put provider API keys in `.dev.vars` beside your Wrangler configuration:

```bash
cat > .dev.vars <<'EOF'
ANTHROPIC_API_KEY="your-api-key"
EOF

printf '\n.dev.vars*\n.env*\n' >> .gitignore
```

Use the variable name your provider expects — `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. Do not commit local secret files. Cloudflare also supports `.env`-based local variables, but use either `.dev.vars` or `.env`, not both; when `.dev.vars` exists, `.env` values are not loaded into local Worker bindings. Flue loads `.env` or one explicitly selected `--env` file before CLI configuration and builds, but Worker runtime variables continue to follow Cloudflare's local-variable rules.

For a deployed Worker, add secrets through Wrangler rather than treating a local-development file as production configuration:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx flue build --target cloudflare
npx wrangler deploy
```

For CI or a managed deployment pipeline, `wrangler deploy --secrets-file <path>` is also available when your pipeline provides a protected secrets file.

### 6. Try it locally

For local development, use `flue dev --target cloudflare`. It builds your project root, then starts a Cloudflare Workers development server through the official Vite integration on port 3583 and watches for changes:

```bash
npx flue dev --target cloudflare
```

Then test it:

```bash
curl http://localhost:3583/workflows/translate?wait=result \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

`flue run` starts the generated server in Node.js, so it only supports `--target node`. Cloudflare builds use Worker-only runtime modules — `flue dev --target cloudflare` is the equivalent for testing them locally.

### WebSocket connections

In an agent module, import `type AgentWebSocketHandler` and export `const websocket: AgentWebSocketHandler = async (_c, next) => next();` to expose a created agent at `GET /agents/:name/:id` with a WebSocket upgrade. It may authenticate the upgrade before calling `next()`. The stable `:id` selects the owning Durable Object-backed agent instance, and a socket may issue sequential prompts. Workflow sockets are available at `GET /workflows/:name`, accept one invocation, and close after their terminal result.

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: 'http://localhost:3583' });
const chat = client.agents.connect('chat', 'customer-123');
await chat.ready;
console.log(await chat.prompt('Hello', { session: 'support' }));
console.log(await chat.prompt('Continue', { session: 'support' }));
chat.close();
```

An exported `websocket` middleware can authenticate its own agent or workflow socket endpoint. Custom `.flue/app.ts` applications provide centralized authentication and mounted prefixes: for example, apply `app.use('/api/agents/*', authenticate)` and `app.use('/api/workflows/*', authenticate)` before `app.route('/api', flue())` to cover both socket surfaces before Flue forwards accepted upgrades into their owning Durable Objects. SDK clients can connect through that mount with `websocketBasePath: '/api'` and attach query-token or signed handshake context with `websocketUrl: (url) => { url.searchParams.set('token', socketToken); return url; }`. HTTP `token` and `headers` options do not automatically apply to WebSocket upgrades; browsers should use cookies or application-designed URL authentication, while Node clients requiring implementation-specific headers can provide a custom `websocket` factory. Cloudflare socket authentication is established during the handshake: query parameters and original upgrade headers are not restored into operation-time request context after Durable Object forwarding. Avoid header-mutating middleware such as CORS wrapping WebSocket upgrade routes, because WebSocket upgrade responses may have immutable headers.

## Subagents

Subagents define named delegates for detached task sessions:

```typescript
import { createAgent, defineAgentProfile } from '@flue/runtime';

const triager = defineAgentProfile({
  name: 'triager',
  instructions: 'Search thoroughly, cite sources, and stay concise.',
});
const support = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', subagents: [triager] }));

const harness = await init(support);
const session = await harness.session();
await session.task('Help me reset my password', { agent: 'triager' });
```

## Using the sandbox

By default, the virtual sandbox starts empty — no files, no skills, no context. This is fine for stateless prompt-and-response agents like the translator above. But many agents need files to work with.

Because the agent has shell access, it can set up its own workspace on the fly:

```typescript
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const reporter = createAgent(() => ({ model: 'openai/gpt-5.5' }));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(reporter);
  const session = await harness.session();

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

## Support agents with context files

For support agents, you can seed Flue's default virtual sandbox with the knowledge required for a request. The agent can search and read these files using its built-in `grep`, `glob`, and `read` tools without provisioning a container or installing a connector.

`.flue/workflows/support.ts`:

```typescript
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const support = createAgent(() => ({ model: 'openrouter/moonshotai/kimi-k2.6' }));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(support);
  const session = await harness.session();

  await session.fs.mkdir('/workspace/articles', { recursive: true });
  await session.fs.writeFile(
    '/workspace/articles/reset-password.md',
    '# Reset your password\n\nUse the account settings page to request a password reset email.',
  );

  return await session.prompt(
    `You are a support agent. Search the workspace for articles relevant
    to this request, then write a helpful response.\n\nCustomer: ${payload.message}`,
  );
}
```

This remains the default just-bash virtual sandbox: it starts quickly, supports shell and filesystem tools, and requires no Worker Loader binding. If an application needs durable external storage or a full Linux environment, choose and own a connector appropriate to that requirement.

## Connecting a remote sandbox

The examples above all run on virtual sandboxes — no container needed. But for agents that need a full Linux environment — git, Node.js, a browser, system packages — you want a remote sandbox.

Cloudflare has native container support via [`@cloudflare/sandbox`](https://developers.cloudflare.com/containers/). Each session gets its own isolated container with a persistent filesystem, shell, and full Linux userspace.

If you'd rather connect to an external provider — e.g. Daytona — instead of running the sandbox on Cloudflare, see [Connect a Daytona Sandbox](https://github.com/withastro/flue/blob/main/docs/connect-daytona.md).

### Setup

You own the container config. That means three things:

1. Install `@cloudflare/sandbox`: `npm install @cloudflare/sandbox`.
2. Declare the Durable Object binding, migration, and container image in your `wrangler.jsonc` at the project root.
3. Commit a `Dockerfile` at the path your `containers[].image` points to.

Flue automates one piece: **any DO binding whose `class_name` ends with `Sandbox` is automatically wired up as `@cloudflare/sandbox`'s `Sandbox` class in the generated Worker bundle.** Pick any name you want (`Sandbox`, `PyBoxSandbox`, `SupportSandbox`, …) and Flue handles the re-export. Append its migration to the same top-level history you use for generated Flue classes; do not replace migrations that have already been deployed.

### Example

`wrangler.jsonc` (at the project root, alongside `package.json`):

```jsonc
{
  "$schema": "https://workers.cloudflare.com/schema/wrangler.json",
  "name": "my-agent",
  "compatibility_date": "2026-04-01",
  "compatibility_flags": ["nodejs_compat"],
  "durable_objects": {
    "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "Assistant"] },
    { "tag": "v2", "new_sqlite_classes": ["Sandbox"] },
  ],
  "containers": [{ "class_name": "Sandbox", "image": "./Dockerfile" }],
}
```

`Dockerfile` (at the project root):

```dockerfile
FROM docker.io/cloudflare/sandbox:0.9.2
```

The base image is published by Cloudflare and bundles the control-plane HTTP server that `@cloudflare/sandbox` needs to communicate with the container, along with `node`, `git`, `curl`, and a working directory at `/workspace`. Pin the tag to match the `@cloudflare/sandbox` version in your `package.json` — they're versioned together. Add your own `RUN` lines to install extra tools as needed.

`.flue/agents/assistant.ts`:

```typescript
import { createAgent, type AgentRouteHandler } from '@flue/runtime';
import { getSandbox } from '@cloudflare/sandbox';

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent(({ id, env }) => ({
  sandbox: getSandbox(env.Sandbox, id),
  model: 'anthropic/claude-opus-4-7',
}));
```

### Multiple sandboxes

Different agents can use different container images. Declare a separate binding for each (each `class_name` must end with `Sandbox`), and give each its own container entry:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "class_name": "PyBoxSandbox", "name": "PyBox" },
      { "class_name": "NodeSandbox", "name": "NodeBox" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "Assistant"] },
    { "tag": "v2", "new_sqlite_classes": ["PyBoxSandbox", "NodeSandbox"] },
  ],
  "containers": [
    { "class_name": "PyBoxSandbox", "image": "./docker/python.Dockerfile" },
    { "class_name": "NodeSandbox", "image": "./docker/node.Dockerfile" },
  ],
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

### When to use a remote sandbox

| Virtual sandbox                  | Remote sandbox                              |
| -------------------------------- | ------------------------------------------- |
| Millisecond startup              | Seconds to start (cached images are faster) |
| Grep, glob, read, basic shell    | Full Linux: git, Node.js, Python, browsers  |
| R2 or inline files               | Real persistent filesystem                  |
| High-traffic / high-scale agents | Coding agents, complex dev environments     |

Most agents don't need a remote sandbox. Start with a virtual sandbox and only move to a remote sandbox when you need the full environment.

## Session persistence

When a generated Cloudflare application handles agent or workflow work through its Durable Object-backed runtime path, Flue stores session conversation state in Durable Object SQLite by default. This retains message history and compaction checkpoints for later operations in that stored session.

Filesystem durability remains a separate decision. The default lightweight sandbox uses an in-memory filesystem and must not be treated as durable merely because conversation state is stored in a Durable Object. Use a durable workspace or container-backed integration when files or installed artifacts must survive later activity. Workflow run history is likewise stored through the workflow durable-runtime path and is distinct from agent session storage.

WebSocket-exposed created agents use the same owning Durable Object scope. Flue's generated Cloudflare transport accepts hibernation-compatible sockets in that Durable Object so long-lived interactive connections retain the correct instance identity.

## Interruption and recovery semantics

A deployment or code update can reset a Durable Object while an operation is running. Flue handles interrupted Cloudflare operations according to their execution model:

| Operation                                                                    | After interruption                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct attached agent HTTP/WebSocket prompt                                  | Flue makes a best-effort retry of interrupted prompt work from its captured input and the latest saved session state. The attached response or socket stream may fail and missed output is not replayed. No public agent run exists. |
| Dispatched agent input                                                       | Durable delivery and deduplication are keyed by `dispatchId` and persisted session/delivery state, not by a run.                                                                                                                     |
| Flue workflow invocation (`202`, SSE, `?wait=result`, or workflow WebSocket) | Flue terminalizes the interrupted run as errored. An attached SSE, synchronous response, or WebSocket may fail. Flue does not automatically start a replacement run.                                                                 |

Cloudflare direct HTTP and WebSocket prompt execution is wrapped in a Fiber that checkpoints the submitted prompt for best-effort retry. Session transcript persistence is unchanged: interrupted assistant/tool progress not yet saved at the normal idle boundary is regenerated from the latest saved session snapshot. There are narrow interruption windows before prompt checkpointing or after transcript save but before Fiber cleanup where retry can be unavailable or duplicate already-completed work.

All Cloudflare workflow invocation transports use the same Fiber-backed durable admission path. The transport controls only how the initiating caller observes the admitted run: immediate `202`, live SSE, a synchronous result, or workflow WebSocket events while the connection remains available.

Recovery is **at-least-once** where durable prompt retry or asynchronous processing applies. An interruption after an external action has begun can cause that action to execute again. For dispatched agent work, use `dispatchId` or an application-level idempotency key when coordinating external side effects. Direct attached prompts do not expose a run identifier or replay API.

Flue persists workflow invocation payloads with workflow run records before admitted work starts so operators can inspect the original input after an interruption. Flue does not automatically retry interrupted workflows. The caller or application should decide whether retry is appropriate and explicitly invoke the workflow again when needed. Use an application-level idempotency key when a repeated invocation may encounter external side effects from an earlier attempt. Dispatched agent inputs are persisted as delivery/session state correlated by `dispatchId`, not as agent runs. Direct prompt Fiber checkpoints capture submitted prompt input for retry but do not create agent runs. Treat persisted inputs as durable application data: do not submit secrets or sensitive values unless your application retention and access policy permits storing them.

Flue workflows do not resume from checkpointed durable steps after Durable Object interruption. For jobs that require durable step-level continuation, implement those steps with [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

### Beta persisted-schema boundary

Flue supports Cloudflare Durable Object SQL state created by `v0.8.0` or newer. Earlier beta schemas are not supported; clear or separately migrate that persisted state before upgrading. Existing supported databases may retain unused historical columns. They do not require table rebuilds.

## Sandbox context

`AGENTS.md` and skills are optional workspace-context files that the agent reads from its sandbox at `init()` time. They live at conventional paths inside whatever sandbox the agent is using — Flue looks for `<cwd>/AGENTS.md` and `<cwd>/.agents/skills/<name>/SKILL.md`. Whatever's there gets loaded; whatever isn't, doesn't. Most agents don't need either to do useful work.

If you want to use them, put them in your sandbox. How you do that depends on which sandbox you're using: write them in via `session.shell()` or `session.fs` for the default virtual sandbox, or `COPY` them in for a container.

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
const { data } = await session.skill('greet', {
  args: { name: 'World' },
  result: v.object({ greeting: v.string() }),
});
```

## Building and deploying

Flue compiles your project into a deployable artifact. For Cloudflare, this means a Workers-compatible bundle:

```bash
# Local development (reads local variables from .dev.vars or .env)
npx flue dev --target cloudflare

# One-off build for Cloudflare
npx flue build --target cloudflare

# Configure a deployed secret interactively, then deploy
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler deploy
```

Every workflow that exports `route` gets an HTTP endpoint automatically. The middleware may authenticate the request and call `next()` to admit it. The route follows the pattern `/workflows/<name>` — for example, `.flue/workflows/translate.ts` becomes `/workflows/translate`.

```bash
# Hit your deployed workflow
curl https://my-support-agent.<your-subdomain>.workers.dev/workflows/translate?wait=result \
  -H "Content-Type: application/json" \
  -d '{"text": "Hello world", "language": "French"}'
```

A deployed WebSocket-exposed agent is reached at `wss://my-support-agent.<your-subdomain>.workers.dev/agents/chat/customer-123` using the same SDK client shown above.

### Choosing a sandbox strategy

Here's the progression of sandbox types available on Cloudflare, from simplest to most powerful:

1. **Empty virtual sandbox** — `createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }))`. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `session.shell()` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **Container sandbox** — Full Linux environment via `@cloudflare/sandbox`. For coding agents, complex dev environments, and anything that needs real system tools.

Start simple. Move up when you need to.
