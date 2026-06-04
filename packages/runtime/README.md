> **Experimental** — Flue is under active development. APIs may change.
>
> Looking for `v0.0.x`? [See here.](https://github.com/withastro/flue/tree/v0.0.x)

# Flue

Flue is **The Agent Harness Framework.** If you know how to use Claude Code (or Codex, OpenCode, Pi, etc)... then you already know the basics of how to build agents with Flue.

Flue is a TypeScript framework for building the next generation of agents, designed around a built-in **agent harness**. It's like Claude Code, but 100% headless and programmable. There's no baked-in assumption like requiring a human operator to function. No TUI. No GUI. Just TypeScript.

But using Flue feels like using Claude Code. The agents you build act autonomously to solve problems and complete tasks. They require very little code to run — most of the "logic" lives in Markdown: skills, context, and `AGENTS.md`.

Flue isn't another AI SDK. It's a proper runtime-agnostic framework — think Astro or Next.js, but for agents. Write once, build, and deploy your agents anywhere (Node.js, Cloudflare, GitHub Actions, GitLab CI/CD, etc).

## Packages

| Package                             | Description                                |
| ----------------------------------- | ------------------------------------------ |
| [`@flue/runtime`](packages/runtime) | Runtime: harness, sessions, tools, sandbox |
| [`@flue/cli`](packages/cli)         | CLI + build/dev tooling (`flue` binary)    |

## Examples

Message-driven agents receive direct HTTP or WebSocket messages at `/agents/:name/:id`; application-owned integrations may call `dispatch(...)` to deliver asynchronous input into agent sessions. See [Message-Driven Agents](https://flueframework.com/docs/guide/message-driven-agents/) for these surfaces. Runnable WebSocket examples are available for [Node](examples/node-websocket) and [Cloudflare](examples/cloudflare-websocket).

For external tracing, metrics, and error reporting, see [Observability](https://flueframework.com/docs/guide/observability/), the official [`@flue/opentelemetry`](packages/opentelemetry) adapter, the public `observe(...)`-based [Braintrust tracing example](examples/braintrust), and the [Sentry error-reporting example](examples/sentry).

### Quickstart

The simplest agent — no container, no tools, just a prompt and a typed result.

Unless you opt-in to initializing a full container sandbox, Flue will default to a virtual sandbox for every agent, powered by [just-bash](https://github.com/vercel-labs/just-bash). A virtual sandbox is going to be dramatically faster, cheaper, and more scalable than running a full container for every agent, which makes it perfect for building high-traffic/high-scale agents.

```ts
// .flue/workflows/hello-world.ts
import { createAgent, type FlueContext, type WorkflowRouteHandler } from '@flue/runtime';
import * as v from 'valibot';

// Public HTTP exposure is enabled by exported Hono middleware.
export const route: WorkflowRouteHandler = async (_c, next) => next();

const translator = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6' }));

// The workflow handler. Where the orchestration of the workflow lives.
export async function run({ init, payload }: FlueContext) {
  // `harness` -- Your initialized harness including sandbox, tools, skills, etc.
  const harness = await init(translator);
  const session = await harness.session();

  // prompt() sends a message in the session, triggering action.
  const { data } = await session.prompt(
    `Translate this to ${payload.language}: "${payload.text}"`,
    {
      // Pass `result` to get typed, schema-validated data back from your agent.
      result: v.object({
        translation: v.string(),
        confidence: v.picklist(['low', 'medium', 'high']),
      }),
    },
  );

  return data;
}
```

### Support Agent

A support agent can also run on Cloudflare without a container by using Flue's default virtual sandbox. Populate its filesystem with the context the agent needs, then it can search that content with its built-in `grep`, `glob`, and `read` tools.

Cloudflare Durable Objects persist stored conversation history across later requests. The default virtual sandbox remains in memory, so seed any files each time you need them or choose a durable sandbox connector for long-lived workspace state.

```ts
// .flue/workflows/support.ts
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

This uses Flue's built-in, just-bash-powered virtual sandbox; no connector or container is required.

### Issue Triage (CI)

A triage agent that runs in CI whenever an issue is opened on GitHub. The `local()` sandbox gives the agent direct access to the host filesystem and shell — perfect for CI runners, where `gh`, `git`, and `npm` are already on `$PATH` and the runner itself is your isolation boundary.

```ts
// .flue/workflows/triage.ts
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

// Because we are running this in CI, we don't need to expose this as an HTTP endpoint.
// The CLI can run any workflow from the command line, `flue run triage ...`
export async function run({ init, payload }: FlueContext) {
  // `local()` gives the agent direct access to the host filesystem and
  // shell. The agent's bash tool can run `gh`, `git`, `npm` directly.
  // Skills and AGENTS.md are discovered from process.cwd().
  //
  // Only a small allowlist of shell-essential env vars (PATH, HOME,
  // locale, etc.) is inherited from process.env by default. Pass
  // `env: { GH_TOKEN: process.env.GH_TOKEN }` to expose more.
  //
  // `model` sets the default model for every prompt/skill call in this
  // agent. Override per-call with `{ model: '...' }` on prompt()/skill().
  const agent = createAgent(() => ({
    sandbox: local({
      env: { GH_TOKEN: process.env.GH_TOKEN },
    }),
    model: 'anthropic/claude-opus-4-7',
  }));
  const harness = await init(agent);
  const session = await harness.session();

  // Workspace-discovered skills are activated by their frontmatter `name:`.
  // Statically imported packaged skills can also be activated by passing their reference.
  const { data } = await session.skill('triage', {
    // Pass arguments to any prompt or skill.
    args: { issueNumber: payload.issueNumber },
    // Result schemas are great for being able to act/orchestrate based on
    // the structured `data` returned from your prompt or skill call.
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
      fix_applied: v.boolean(),
    }),
  });

  return data;
}
```

### Coding Agent (Remote Sandbox)

The examples above all run on a lightweight virtual sandbox — no container needed. But for a full coding agent, you want a real Linux environment with git, Node.js, a browser, and a cloned repo ready to go.

Daytona's declarative image builder lets you define the environment in code. The image is cached after the first build, so subsequent sessions start instantly.

Install the Daytona connector with `flue add daytona | <your-agent>` (e.g. `claude`, `opencode`, `codex`, `cursor-agent`). It writes a small `connectors/daytona.ts` adapter into your project that you import directly.

```ts
// .flue/workflows/code.ts
import {
  Type,
  createAgent,
  defineTool,
  type FlueContext,
  type WorkflowRouteHandler,
} from '@flue/runtime';
import { Daytona } from '@daytona/sdk';
import { daytona } from '../connectors/daytona';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init, payload, env }: FlueContext) {
  // Each agent gets a real container via Daytona. The container has
  // a full Linux environment with persistent filesystem and shell.
  //
  // For simplicity, we always create a new sandbox here. You could also
  // first check for an existing sandbox for the agent instance id, and reuse that
  // instead to best pick up where you last left off in the conversation.
  const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
  const sandbox = await client.create();
  const setupAgent = createAgent(() => ({
    sandbox: daytona(sandbox),
    model: 'openai/gpt-5.5',
  }));
  const setupHarness = await init(setupAgent, { name: 'setup' });
  const setup = await setupHarness.session();

  // For simplicity, we clone the target repo into the sandbox here.
  // You could also bake these into the container image snapshot for a
  // faster / near-instant startup.
  await setup.shell(`git clone ${payload.repo} /workspace/project`);
  await setup.shell('npm install', { cwd: '/workspace/project' });

  // Start a second harness in the cloned repo. It shares the same sandbox, but
  // discovers AGENTS.md and skills from /workspace/project.
  const projectAgent = createAgent(() => ({
    sandbox: daytona(sandbox),
    cwd: '/workspace/project',
    model: 'openai/gpt-5.5',
  }));
  const projectHarness = await init(projectAgent, { name: 'project' });
  const session = await projectHarness.session();

  // Coding agents don't hide the agent DX from the user, so no need to
  // wrap the user's prompt in anything. Just send it to the agent directly
  // and then stream back the progress and final results.
  return await session.prompt(payload.prompt);
}
```

### Remote MCP Tools

MCP is available as a runtime tool adapter. Connect to a remote MCP server in trusted code, pass its tools to `init()`, and keep secrets in `env` instead of filesystem context or prompts.

```ts
// .flue/workflows/assistant.ts
import {
  connectMcpServer,
  createAgent,
  type FlueContext,
  type WorkflowRouteHandler,
} from '@flue/runtime';

export const route: WorkflowRouteHandler = async (_c, next) => next();

export async function run({ init, payload, env }: FlueContext) {
  const github = await connectMcpServer('github', {
    url: 'https://mcp.github.com/mcp',
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
    },
  });

  try {
    const agent = createAgent(() => ({
      model: 'anthropic/claude-sonnet-4-6',
      tools: github.tools,
    }));
    const harness = await init(agent);
    const session = await harness.session();
    return await session.prompt(payload.prompt);
  } finally {
    await github.close();
  }
}
```

`connectMcpServer()` defaults to modern streamable HTTP. For legacy SSE servers, pass `transport: 'sse'`. Flue does not auto-detect transports, spawn local stdio MCP servers, or handle OAuth callbacks in this first version.

## Agents, Harnesses, And Sessions

An agent is the source file in `agents/<name>.ts`. For attached HTTP or WebSocket agents, the URL `<id>` segment identifies the agent instance: the durable runtime scope for one customer, repo, conversation space, or other caller-defined boundary.

```txt
POST /agents/<agent-name>/<id>
GET  /agents/<agent-name>/<id>  (Upgrade: websocket)
```

In an agent module, import `type AgentWebSocketHandler` and export `const websocket: AgentWebSocketHandler = async (_c, next) => next();` to open a long-lived SDK connection to that stable instance; it may add authentication before calling `next()`. One agent socket can issue sequential prompts and select a session per prompt; workflow sockets are one invocation per connection.

In workflows, `init(createdAgent)` creates a harness: a configured handle for model defaults, tools, sandbox, filesystem, and sessions. Pass `init(createdAgent, { name })` when one workflow needs multiple isolated harness scopes. In agent modules, the runtime initializes the module's default `createAgent(...)` export when a message arrives.

By default, `harness.session()` opens the default session inside the default harness for that agent instance. Reuse the same URL `<id>` to continue the same agent instance. Use a new URL `<id>` to start fresh.

Runs belong to workflows only. Direct HTTP and WebSocket prompts are attached interactions with an agent session. Asynchronous agent delivery uses `dispatch(...)`, whose `dispatchId` identifies delivery rather than a run. Agent interactions do not appear in `/runs` and are not inspected with `flue logs`.

```bash
# Start a conversation (port 3583 is `flue dev`'s default)
curl http://localhost:3583/agents/hello/session-abc \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello, Alice"}'

# Continue that conversation
curl http://localhost:3583/agents/hello/session-abc \
  -H "Content-Type: application/json" \
  -d '{"message": "What did I just say?"}'

# Start a separate conversation
curl http://localhost:3583/agents/hello/session-xyz \
  -H "Content-Type: application/json" \
  -d '{"message": "Hello from another conversation"}'
```

Agent instances provide a stable identity boundary for prompt and dispatched-input interactions. Harnesses group related session state within an instance. Sessions persist message history and conversation metadata inside a harness. Sandbox-file durability depends on the configured sandbox or connector; the default virtual filesystem is in memory. On Cloudflare, session conversation data is backed by Durable Objects and survives across requests. On Node.js, sessions are stored in memory by default unless you provide a custom store.

In production, generate a stable URL `<id>` for the agent instance you want to preserve. Use `harness.session(threadName)` when you need multiple conversations inside the same harness.

### Tasks

Use `session.task()` to run a focused, one-shot child agent in a detached session. Tasks share the same sandbox/filesystem, but get their own message history and discover `AGENTS.md` plus `.agents/skills/` from their working directory. The same `task` tool is also available to the LLM during `prompt()` and `skill()` calls, so the agent can delegate parallel research or exploration work itself.

```ts
const session = await harness.session();

const research = await session.task('Research the auth flow and summarize the key files.', {
  cwd: '/workspace/project',
  agent: 'researcher',
});

const answer = await session.prompt(
  `Use this research to draft the implementation plan:\n\n${research.text}`,
);
```

Declare reusable subagent profiles with `defineAgentProfile()`, configure them in `createAgent(...)`, and select them for detached delegation with `task({ agent })`.

```ts
const researcher = defineAgentProfile({ name: 'researcher', instructions: 'Research carefully.' });
const workflowAgent = createAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  subagents: [researcher],
}));
const harness = await init(workflowAgent);
const session = await harness.session('review-thread');

await session.prompt('Review the latest changes.');
await session.task('Research related issues.', { agent: 'researcher' });
```

### Provider Settings

Use `configureProvider(...)` when model traffic needs provider-specific runtime
settings, such as an enterprise API gateway, provider-compatible proxy, custom
endpoint, or gateway-specific credentials. This is common for managed credentials,
audit logging, traffic routing, or self-hosted OpenAI-compatible providers.

Configure these settings in `app.ts` using the provider ID from the model value.
They apply to every harness and session that resolves models through that provider.

```ts
// .flue/app.ts
import { configureProvider } from '@flue/runtime';
import { flue } from '@flue/runtime/routing';

export default {
  fetch(req, env, ctx) {
    configureProvider('anthropic', {
      baseUrl: env.ANTHROPIC_BASE_URL,
      headers: { 'X-Custom-Auth': env.GATEWAY_KEY },
      // Use this when the proxy expects a synthetic or gateway-specific key.
      apiKey: 'dummy',
    });

    return flue().fetch(req, env, ctx);
  },
};
```

### Imported Agent Skills

Workspace skills at `<cwd>/.agents/skills/<name>/SKILL.md` are discovered at runtime and activated by name with `session.skill('name')`. Static skill imports are packaged build dependencies:

```ts
import review from '../skills/review/SKILL.md' with { type: 'skill' };

const agent = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', skills: [review] }));
const harness = await init(agent);
const session = await harness.session();
await session.skill('review');
// Or activate an imported reference directly: await session.skill(review);
```

The static import exposes a lightweight `SkillReference`, not skill contents. Vite validates the spec-compliant `SKILL.md` and packages every permitted supporting file in its skill directory, not only `scripts/`, `references/`, and `assets/`. Packaged files become readable for direct reference activation and for operations on an agent that registers the reference in `skills`; an unregistered import alone does not expose its contents to ordinary prompts. Files likely to contain secrets or private keys, including `.env*`, `.dev.vars*`, credential files, key files, `.aws/`, `.ssh/`, and `.gnupg/`, reject the build rather than being deployed. Keep credentials outside skill directories.

### Custom Virtual Sandboxes

For most agents, use the built-in virtual sandbox or `sandbox: local()` (Node target only). The generated default sandbox is supplied by `@flue/runtime`; applications do not declare `just-bash` unless authored application code imports it directly. If you need to customize just-bash directly, add `just-bash` as an application dependency and pass a Bash factory. The factory must return a fresh Bash-like runtime each time; share the filesystem object in the closure to persist files across sessions and prompts.

```ts
import { Bash, InMemoryFs } from 'just-bash';

const fs = new InMemoryFs();

const agent = createAgent(() => ({
  sandbox: () => new Bash({ fs, cwd: '/workspace', python: true }),
  model: 'anthropic/claude-sonnet-4-6',
}));
const harness = await init(agent);
const session = await harness.session();
```

## Connectors

Connectors adapt third-party services (sandbox providers, etc.) into Flue. They are not an npm package — they are markdown installation instructions hosted at `https://flueframework.com/cli/connectors/` and applied to your project by your AI coding agent.

```bash
flue add                                            # list available connectors
flue add daytona | claude                           # pipe to your coding agent (claude, opencode, codex, cursor-agent, ...)
flue add https://e2b.dev --category sandbox | claude   # build one from scratch — pass the provider's docs URL as the agent's starting point
```

The CLI fetches the markdown for the named connector and prints it to stdout when run by an agent (or with `--print`), or shows a short copyable `flue add ... | <agent>` recipe when run by a human in a terminal. Your agent reads the markdown and writes a small TypeScript adapter under the selected source directory: `.flue/`, then `src/`, then the project root.

## Running and Connecting

### Local Development (`flue dev`)

Long-running watch-mode dev server. Rebuilds and reloads on file changes — edit an agent, re-run `curl`, see your change.

```bash
flue dev --target node          # Node.js dev server
flue dev --target cloudflare    # Cloudflare Vite/workerd dev server
```

Defaults to port `3583` ("FLUE" on a phone keypad). Override with `--port`.

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: 'http://localhost:3583' });
const chat = client.agents.connect('chat', 'customer-123');
await chat.ready;
await chat.prompt('Hello', { session: 'support' });
chat.close();

const job = client.workflows.connect('summarize');
await job.ready;
await job.invoke({ text: 'Summarize me' });
```

An exported `websocket` middleware can authenticate its own agent or workflow socket endpoint. Use a custom `app.ts` for centralized authentication or mounted prefixes, applying ordinary Hono middleware before `app.route('/api', flue())`; the same routing model works on Node and Cloudflare. Include the custom mount in `baseUrl: 'https://example.com/api'` and use `websocketUrl: (url) => { url.searchParams.set('token', socketToken); return url; }` for URL-carried or signed handshake authentication. HTTP `token` and `headers` options do not automatically apply to WebSocket upgrades; browsers should use cookies or application-designed URL authentication, while Node clients needing implementation-specific headers can provide a custom `websocket` factory. Avoid header-mutating middleware around WebSocket upgrade routes. Install `wrangler` in Cloudflare projects that use Wrangler commands such as `wrangler deploy` or secret management; `flue dev --target cloudflare` no longer requires it as an `@flue/cli` peer dependency.

#### Loading environment variables

`flue build`, `flue dev`, `flue run`, and `flue connect` load project-root `.env` before configuration when it exists:

```bash
flue dev --target node
```

Use `--env <path>` to select one alternate file instead; shell-set values win. `flue build` may use loaded values while evaluating configuration, but emitted artifacts do not load `.env` at deployment runtime. For Cloudflare development, Worker runtime bindings continue to use the official `.dev.vars` or `.env` files and `CLOUDFLARE_ENV` convention.

### Trigger From the CLI (`flue run`)

Build and run any workflow locally, perfect for CI or one-shot scripted invocations. The CLI invokes the built Node artifact through private child-process communication, independent of public workflow routes and middleware.

```bash
flue run hello --target node \
  --payload '{"text": "Hello world", "language": "French"}'
```

### Connect to an Agent Instance (`flue connect`)

Open an interactive local session with an agent instance. The built Node child remains alive for the connection so repeated prompts can share in-memory session state.

```bash
flue connect chat customer-123 --target node --session support
```

### Trigger From HTTP Endpoint (`flue build`)

Build and deploy your agents as a web server, perfect for hosted agents.

`flue build` builds to a `./dist` directory, which you can then deploy. Cloudflare and any Node.js host are supported today, with more coming in the future.

```
flue build --target node          # Node.js server (single bundled .mjs)
flue build --target cloudflare    # Cloudflare Workers + Durable Objects
```

For Cloudflare, `flue build` and `flue dev` run through the official Cloudflare Vite/workerd integration. A production build emits deployable output consumed by `wrangler deploy`.
