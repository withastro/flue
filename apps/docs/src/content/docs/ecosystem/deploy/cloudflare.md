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
npm install @flue/runtime valibot 'agents@^0.14.1'
npm install -D @flue/cli wrangler
```

`agents` is Cloudflare's Agents SDK — Flue uses its Durable Object base class and native lifecycle capabilities while retaining ownership of application routing. Flue is tested against `agents` 0.14.x; the generated worker checks at runtime that the installed SDK provides the durability API it relies on (such as `runFiber`) and fails with an explicit error if it does not. If you also need a remote sandbox, additionally install `@cloudflare/sandbox` (see [Connecting a remote sandbox](#connecting-a-remote-sandbox) below).

### 2. Create your first agent

`.flue/workflows/translate.ts`:

```typescript
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

export const route: WorkflowRouteHandler = async (_c, next) => next();

const translator = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export async function run({ init, payload }: FlueContext<{ text: string; language: string }>) {
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
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueTranslateWorkflow"] }],
}
```

Every Cloudflare target includes `FlueRegistry`. Flue-owned bindings use upper snake case and generated classes use PascalCase: `.flue/workflows/translate.ts` binds `FLUE_TRANSLATE_WORKFLOW` to `FlueTranslateWorkflow`, while `.flue/agents/support-chat.ts` binds `FLUE_SUPPORT_CHAT_AGENT` to `FlueSupportChatAgent`.

Keep deployed migration entries in order. When you add an agent or workflow later, append a uniquely tagged migration for its new class. Generated Flue agent classes require Durable Object SQLite: introduce them through `new_sqlite_classes`, not legacy `new_classes`. An already deployed KV-backed Durable Object class cannot be converted to SQLite in place. For this pre-1.0 agent durability upgrade, use a fresh generated agent class identity and treat deployment as a hard execution-state boundary: in-flight direct prompts and dispatched inputs from earlier generated-agent identities are not adopted. Use Cloudflare's explicit rename or delete migrations when changing a deployed class lifecycle. When upgrading a workflow deployment created before this naming scheme, append `renamed_classes` entries such as `{ "from": "TranslateWorkflow", "to": "FlueTranslateWorkflow" }`; do not rewrite deployed migration history.

### 4. Build and deploy

```bash
npx flue build --target cloudflare
npx wrangler deploy
```

`flue build --target cloudflare` compiles your project into a `./dist` directory containing a Cloudflare Workers-compatible artifact. `wrangler deploy` pushes it live.

### Serving assets from the same Worker

Workers static assets are served before your Worker script unless `assets.run_worker_first` says otherwise. If a single Worker serves a front-end build and application routes that invoke Flue, include every application-owned API prefix and every mounted Flue prefix in `run_worker_first` so those requests reach Hono instead of the asset handler or SPA fallback:

```jsonc title="wrangler.jsonc"
{
  "assets": {
    "directory": "./dist/client",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*", "/_flue/*"],
  },
}
```

Adjust the prefixes to match where your `app.ts` mounts public routes and `flue()`. If Flue is mounted at `/api`, include `/api/*`; if your application mounts Flue at a private internal prefix, include that prefix too and protect it with middleware.

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

Route middleware sees the original inbound HTTP request before Flue forwards accepted work into its Durable Object. Durable direct-agent processing is a later boundary: after admission, Flue uses a deterministic internal request and does not persist or reconstruct the caller's original headers, cookies, query parameters, URL, or body as operation-time `ctx.req`. Authenticate before admission and carry any non-secret correlation you need later in application-owned input or storage.

### Extending generated Cloudflare Durable Objects

Flue normally owns each generated agent and workflow Durable Object class. When an addressable agent or workflow needs native Cloudflare Agents SDK capabilities such as `onStart()`, `schedule()`, `scheduleEvery()`, or `queue()`, export a `cloudflare` extension descriptor from its module:

```ts
import { createAgent } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';

export default createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

export const cloudflare = extend({
  base: (Base) =>
    class extends Base {
      async onStart() {
        await this.scheduleEvery(60, 'heartbeat');
      }

      async heartbeat() {
        this.setState({ ...this.state, lastHeartbeatAt: Date.now() });
      }
    },
});
```

This is an advanced Cloudflare-only extension point. Flue applies `base` first, then defines its own Durable Object subclass with the generated Flue binding and class identity. For `.flue/agents/support-chat.ts`, authored Worker code can access the namespace as `env.FLUE_SUPPORT_CHAT_AGENT`, and Wrangler binds that name to `FlueSupportChatAgent`. For `.flue/workflows/translate.ts`, the corresponding names are `env.FLUE_TRANSLATE_WORKFLOW` and `FlueTranslateWorkflow`. Use `base` for native SDK lifecycle hooks and additional named methods. Do not override `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()`: Flue and the Agents SDK use those methods for routing, interruption recovery, and alarm multiplexing.

Use `wrap` when an integration needs to wrap the final Flue-generated Durable Object class:

```ts
import * as Sentry from '@sentry/cloudflare';

export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry((env: Env) => ({ dsn: env.SENTRY_DSN }), Final),
});
```

Both `base` and `wrap` are optional. Do not override Flue-owned `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()` methods. This module-local export is distinct from the optional source-root `.flue/cloudflare.ts` deployment module below. Native SDK callbacks run as Durable Object activity: they do not receive a Flue workflow context, create workflow runs, or automatically initialize a Flue harness or session. For deployment-wide scheduled work, see [Scheduling](/docs/guide/scheduling/).

### Extending the Worker

Add an optional `.flue/cloudflare.ts` module when your deployment needs native Cloudflare capabilities outside Flue's generated classes. Named exports become top-level Worker exports, which lets the same Worker define application-owned Durable Objects:

```ts
import { DurableObject } from 'cloudflare:workers';

export class SalesforceAuthCache extends DurableObject {
  async refreshIfNeeded() {
    return await this.ctx.storage.get('token');
  }
}
```

Declare the corresponding binding and migration in your project-root `wrangler.jsonc`:

```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "SALESFORCE_AUTH_CACHE", "class_name": "SalesforceAuthCache" }],
  },
  "migrations": [{ "tag": "v2", "new_sqlite_classes": ["SalesforceAuthCache"] }],
}
```

Your agents and workflows receive the namespace through `env.SALESFORCE_AUTH_CACHE`. Keep bindings, containers, and ordered migration history in Wrangler configuration; `cloudflare.ts` provides the Worker code exports but does not infer deployment topology.

An optional default export adds non-HTTP Worker handlers:

```ts
export default {
  async scheduled(_controller, env) {
    await env.SALESFORCE_AUTH_CACHE.getByName('default').refreshIfNeeded();
  },
};
```

Use `.flue/app.ts` for custom HTTP routes and middleware. `cloudflare.ts` must not export a default `fetch` handler because Flue keeps HTTP composition in `app.ts`.

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

export async function run({ init, payload }: FlueContext<{ topic: string }>) {
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

export async function run({ init, payload }: FlueContext<{ message: string }>) {
  const harness = await init(support);
  const session = await harness.session();

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

If you'd rather connect to an external provider — e.g. Daytona — instead of running the sandbox on Cloudflare, see [Connect a Daytona Sandbox](/docs/ecosystem/sandboxes/daytona/).

### Setup

You own the container config. That means four things:

1. Install `@cloudflare/sandbox`: `npm install @cloudflare/sandbox`.
2. Export the Sandbox class from `.flue/cloudflare.ts`.
3. Declare the Durable Object binding, migration, and container image in your `wrangler.jsonc` at the project root.
4. Commit a `Dockerfile` at the path your `containers[].image` points to.

Append the Sandbox migration to the same top-level history you use for generated Flue classes; do not replace migrations that have already been deployed.

### Example

`.flue/cloudflare.ts`:

```ts
export { Sandbox } from '@cloudflare/sandbox';
```

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
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueAssistantAgent"] },
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
import { cloudflareSandbox } from '@flue/runtime/cloudflare';
import { getSandbox } from '@cloudflare/sandbox';

export const route: AgentRouteHandler = async (_c, next) => next();

export default createAgent(({ id, env }) => ({
  sandbox: cloudflareSandbox(getSandbox(env.Sandbox, id)),
  model: 'anthropic/claude-opus-4-7',
}));
```

### Multiple sandboxes

Different agents can use different container images. Export a separate alias for each Sandbox class, then declare each binding and container entry:

```ts
// .flue/cloudflare.ts
export { Sandbox as PyBoxSandbox } from '@cloudflare/sandbox';
export { Sandbox as NodeSandbox } from '@cloudflare/sandbox';
```

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "class_name": "PyBoxSandbox", "name": "PyBox" },
      { "class_name": "NodeSandbox", "name": "NodeBox" },
    ],
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["FlueRegistry", "FlueAssistantAgent"] },
    { "tag": "v2", "new_sqlite_classes": ["PyBoxSandbox", "NodeSandbox"] },
  ],
  "containers": [
    { "class_name": "PyBoxSandbox", "image": "./docker/python.Dockerfile" },
    { "class_name": "NodeSandbox", "image": "./docker/node.Dockerfile" },
  ],
}
```

Each agent grabs the sandbox it needs: `cloudflareSandbox(getSandbox(env.PyBox, id))` or `cloudflareSandbox(getSandbox(env.NodeBox, id))`.

### Secure egress with outbound Workers

When your agent runs in a container, it may need to call external APIs — GitHub, npm registries, internal services. The traditional approach is to inject API tokens as environment variables, but that means the agent (and the LLM) has direct access to those secrets.

Cloudflare Sandboxes solve this with [outbound Workers](https://blog.cloudflare.com/sandbox-auth/) — a programmable egress proxy that intercepts outgoing HTTP/HTTPS requests from the container. Secrets are injected at the proxy layer, so the container never sees them. This is configured on the Cloudflare Sandbox class, outside of your Flue agent code:

```typescript
import { Sandbox } from '@cloudflare/sandbox';

export class MySandbox extends Sandbox {
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

Agent events are durably stored and can be replayed from any offset via the Durable Streams protocol at `GET /agents/:name/:id`.

## Interruption and recovery semantics

A deployment or code update can reset a Durable Object while an operation is running. Flue handles interrupted Cloudflare operations according to their execution model:

| Operation                                                                    | After interruption                                                                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Direct attached agent HTTP prompt                                            | The accepted prompt remains queued independently of its transport. Flue requeues only when canonical input is provably absent, recognizes provably completed canonical output, and otherwise records a visible terminal interruption without blindly replaying provider work. No public agent run exists. |
| Dispatched agent input                                                       | Durable delivery and internal deduplication are keyed by `dispatchId` and persisted submission state, not by a run. Direct and dispatched inputs to one agent instance share one accepted order. Reconciliation uses the same conservative replay rules.                                                   |
| Flue workflow invocation (`202` or `?wait=result`)                           | Flue terminalizes the interrupted run as errored. An attached synchronous response may fail. Flue does not automatically start a replacement run.                                                                                                                                      |

Cloudflare direct prompts and dispatched inputs enter one SQLite-backed submission queue owned by the target agent Durable Object. The attached transport observes accepted backend work but does not own it: losing an HTTP response does not cancel the accepted submission. Agent events are durably stored and can be replayed from any offset via the Durable Streams protocol.

Before provider processing starts, Flue persists canonical submitted input and records an operational input-application boundary. After interruption, Flue retries only when it can prove provider work did not cross that boundary. If replay safety is uncertain, it appends a framework interruption advisory to canonical session history and terminalizes the operational submission instead of risking duplicate model work or external effects. Later prompts to the same agent instance can see that factual advisory.

All Cloudflare workflow invocations use the same Fiber-backed durable admission path. The transport controls only how the initiating caller observes the admitted run: immediate `202` or a synchronous result. Run events are durably stored and can be streamed independently via `GET /runs/:runId`.

External effects remain application-owned. An interruption can leave the outcome of already-started model or tool activity uncertain, and an explicit caller retry can repeat effects. For dispatched agent work, correlate effects with `dispatchId` or an application-level idempotency key. Direct attached prompts do not expose a public receipt or replay API.

Flue persists workflow invocation payloads with workflow run records before admitted work starts so operators can inspect the original input after an interruption. Flue does not automatically retry interrupted workflows. The caller or application should decide whether retry is appropriate and explicitly invoke the workflow again when needed. Use an application-level idempotency key when a repeated invocation may encounter external side effects from an earlier attempt. Agent submission payloads are likewise durable application data while queued and running. Settled submission data is retained indefinitely in this beta release. Dispatch receipt rows persist indefinitely as well, providing duplicate-delivery protection for repeated forwarding of one `dispatchId`; there is no public submission lookup API. Treat persisted inputs as sensitive: do not submit secrets unless your application retention and access policy permits storing them.

When Flue terminalizes an admitted interrupted workflow run, it emits `run_resume` before `run_end`, including when the interruption happened before live observers received `run_start`. This is recovery of terminal handling, not resumed or retried workflow code. Flue does not automatically propagate a trace carrier with dispatched input or preserve the original attached direct request after durable admission. For trace interpretation and application-owned HTTP extraction, see [Observability](/docs/guide/observability/#attach-application-trace-context).

Flue workflows do not resume from checkpointed durable steps after Durable Object interruption. For jobs that require durable step-level continuation, implement those steps with [Cloudflare Workflows](https://developers.cloudflare.com/workflows/).

### Beta persisted-schema boundary

Flue supports the Cloudflare Durable Object SQL table shape created by `v0.8.0` or newer. Existing supported SQLite-backed databases receive additive execution-store tables such as `flue_agent_submissions` at runtime and may retain unused historical columns; they do not require table rebuilds. Flue stamps every Durable Object database with its persisted schema version in a one-row `flue_meta` table the first time it opens it, and refuses to open a database stamped by a newer Flue version (for example, after rolling back a deploy). KV-backed Durable Object classes remain outside this boundary because Cloudflare cannot convert them to SQLite in place. Persisted agent session records still follow Flue's beta session-data version boundary. Clear or separately migrate records written by an older session-data schema before upgrading.

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

Stream events from a deployed agent with `GET https://my-support-agent.<your-subdomain>.workers.dev/agents/chat/customer-123?offset=-1&live=sse`. Live reads require an `offset` — use `-1` to replay from the start, or `now` for future events only (see the [Streaming Protocol](/docs/api/streaming-protocol/)).

### Choosing a sandbox strategy

Here's the progression of sandbox types available on Cloudflare, from simplest to most powerful:

1. **Empty virtual sandbox** — `createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }))`. Fast, cheap, stateless. Good for prompt-and-response agents.
2. **Virtual sandbox with shell setup** — Use `session.shell()` to write files and configure the workspace. Still fast and cheap, good for agents that need small amounts of static context.
3. **Container sandbox** — Full Linux environment via `@cloudflare/sandbox`. For coding agents, complex dev environments, and anything that needs real system tools.

Start simple. Move up when you need to.
