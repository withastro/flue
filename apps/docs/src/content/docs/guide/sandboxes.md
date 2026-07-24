---
title: Sandboxes
description: Give your agent a workspace — the filesystem and shell where it reads, writes, and runs commands.
lastReviewedAt: 2026-07-21
---

A **sandbox** is an execution environment you attach to an agent: a filesystem and shell where it reads, writes, and runs commands. An agent doesn't have one unless you give it one — `useSandbox()` is what adds file and command access. This guide covers what attaching a sandbox brings, the in-memory virtual sandbox, binding an agent to the host machine with `local()`, remote provider sandboxes, and how an agent's environment can change over its life.

## What a sandbox adds

An agent has at most one environment, and attaching it defines several capabilities at once:

- **The file and shell tools.** With a sandbox attached, the agent's tool set gains `read`, `write`, `edit`, `bash`, `grep`, and `glob`, all operating on it. When the model runs `bash`, the command executes wherever the sandbox says commands execute. (A sandbox can also replace this tool set with its own — see [Sandbox-provided tools](#sandbox-provided-tools).)
- **Workspace context.** At initialization, Flue looks around the sandbox's working directory and composes what it finds into the agent's system prompt: the working directory path, a directory listing, and the contents of `AGENTS.md` when present.
- **Workspace skills.** Skill directories under `<cwd>/.agents/skills/` are discovered at the same time and offered to the agent by name, no import required. See [Skills](/docs/guide/skills/#workspace-skills).
- **Subagents.** Delegates share the parent's environment — same filesystem, same tools. A `task` call can scope a child to a different working directory, but never to a different sandbox. See [Subagents](/docs/guide/subagents/#what-a-subagent-inherits).
- **Your application code.** [Harness tools](/docs/guide/tools/#harness-tools) reach the same environment as `harness.sandbox`, for staging files in and out without a conversation record.

Without a sandbox, an agent simply has none of this: no file or shell tools, no workspace in its prompt, and `harness.sandbox` throws. Everything else — custom tools, skills, subagents, state — works the same either way, and plenty of agents never need more.

Choose the narrowest environment that supports the task: expanding it expands what model-directed work can read, change, execute, and reach.

## The virtual sandbox

The lightest environment is a **virtual sandbox** — an in-memory filesystem paired with an emulated bash, implemented entirely in TypeScript (the [just-bash](https://github.com/vercel-labs/just-bash) engine). Most of the standard unix toolbox works — `ls`, `sed`, `awk`, `jq`, `sort`, pipes, redirects — plus `curl` for HTTP. No real process is ever spawned.

Add `just-bash` to your project's dependencies and wrap an instance with the `bash(...)` helper:

```ts title="src/agents/scratch-worker.ts"
'use agent';
import { bash, useModel, useSandbox } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export function ScratchWorker() {
  useModel('anthropic/claude-haiku-4-5');
  useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));
  return 'Fetch, reshape, and summarize the data the user points you at.';
}
```

Two properties define it:

- **It's isolated from the host.** Commands are emulated in-process; the model cannot reach your host filesystem, processes, or environment variables. The network is opt-in: pass `network: { allowedUrlPrefixes: [...] }` (or `dangerouslyAllowFullInternetAccess: true`) to let the emulated `curl` reach out.
- **It's ephemeral.** The filesystem starts empty and is rebuilt fresh each time the runtime initializes the agent for new work. Files written while processing one message are gone by the next. Keep durable knowledge in [persistent state](/docs/guide/agent-hooks/#persisted-state), and use a real sandbox when files themselves must last.

This is enough for many production agents — `curl`-and-`jq` data work, text reshaping, anything that only needs scratch space.

Application code reaches the same environment as `harness.sandbox`, so a [harness tool](/docs/guide/tools/#harness-tools) can stage an input file, let the agent work on it, and collect the result:

```ts title="src/shared/review-tools.ts"
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export const reviewDocument = defineTool({
  name: 'review_document',
  description: 'Review one supplied document and report findings.',
  input: v.object({ document: v.string() }),
  harness: true,

  async run({ harness, data }) {
    await harness.sandbox.writeFile('document.md', data.document);
    await harness.prompt('Review document.md and write your findings to review.md.');
    return { review: await harness.sandbox.readFile('review.md') };
  },
});
```

The model sees `document.md` appear in its workspace and works on it with the file tools; your application provides the input and retrieves `review.md`; none of the staging enters the conversation.

### Seeding files and commands

The just-bash instance is yours to configure — seed files, allowlist network access, or add custom commands:

```ts title="src/agents/catalog-analyst.ts"
'use agent';
import { bash, useModel, useSandbox } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import { exportCatalogCsv } from '../shared/catalog.ts';

export function CatalogAnalyst() {
  useModel('anthropic/claude-haiku-4-5');
  useSandbox(
    bash(
      () =>
        new Bash({
          fs: new InMemoryFs({ '/data/catalog.csv': exportCatalogCsv() }),
          network: { allowedUrlPrefixes: ['https://api.example.com/'] },
        }),
    ),
  );
  return 'Answer questions about the product catalog in /data/catalog.csv.';
}
```

The agent gets a filesystem with the catalog in place and a `curl` that only reaches your API, all still in-memory.

## Attaching a sandbox

The `useSandbox()` hook attaches an environment inside the agent function, like any other [agent hook](/docs/guide/agent-hooks/):

```ts
useSandbox(factory);
useSandbox(factory, { cwd: '/srv/checkouts/flue' });
```

A few rules shape how it behaves:

- **At most once per render.** An agent has one environment. Call it in the agent body or inside a single custom hook; a second call in the same render throws. It also throws inside a subagent's render — delegates share the parent's environment.
- **The factory is lazy.** Constructing the factory value on every render is cheap by design. The expensive work happens inside the factory's `createSessionEnv()`, which the runtime calls once when it initializes the agent — never on re-renders.
- **The factory receives the agent instance id.** Adapters can key provider resources on it, which is how a remote sandbox gives each conversation its own durable workspace (more below).
- **`cwd` scopes the working directory** inside the environment, resolved once at initialization against the sandbox's own base directory. It determines where commands run by default and where workspace discovery (`AGENTS.md`, skills, the directory listing) happens.

## The local sandbox

On the [Node.js target](/docs/guide/node-target/), the built-in `local()` factory binds the agent directly to the host: file operations use the real filesystem, and `bash` commands run as real processes through the host shell. There is no isolation, by design. Use it for development tools, CI tasks, coding agents, and self-hosted automation where the host environment either is the workspace or already provides the isolation (a container, a dedicated VM). Do not use it as an isolation boundary for untrusted requests or multiple tenants.

```ts title="src/agents/release-manager.ts"
'use agent';
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function ReleaseManager() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local({ env: { GH_TOKEN: process.env.GH_TOKEN } }));
  return 'Prepare the release: check CI status, draft the changelog, tag the release.';
}
```

The working directory defaults to `process.cwd()`; override it with `local({ cwd })`.

The model's shell does **not** inherit your process environment. Only a short allowlist of shell essentials passes through by default — `PATH`, `HOME`, `USER`, `LANG`, `TERM`, `TMPDIR`, and the like — and never API keys, tokens, or cloud credentials. Anything else is an explicit, per-variable opt-in through the `env` option, as `GH_TOKEN` is above. Set a key to `undefined` to drop one of the defaults. Passing `env: { ...process.env }` hands the model's shell your entire host environment, secrets included — do that only in environments you fully trust. The snapshot is taken once when the sandbox is constructed; later changes to `process.env` are not picked up.

Before widening the shell's credentials, consider whether a narrow application [tool](/docs/guide/tools/) can perform the privileged action instead — a model-directed shell should hold as little as possible.

See the [Node.js target guide](/docs/guide/node-target/#local-sandbox) for the full `local()` reference.

## Remote sandboxes

When agent work needs per-conversation isolation, a full Linux toolchain, or code you wouldn't run on your own host, attach a provider-managed sandbox through a **sandbox adapter**. An adapter is a small file in your project that wraps a provider's SDK into the sandbox factory contract.

Add one with the [`flue add`](/docs/cli/add/) blueprint command:

```bash
flue add sandbox e2b
```

The blueprint walks your coding agent through creating `<source-dir>/sandboxes/e2b.ts` and installing the provider SDK. The Ecosystem catalog lists supported providers — including [Daytona](/docs/ecosystem/sandboxes/daytona/), [E2B](/docs/ecosystem/sandboxes/e2b/), [Modal](/docs/ecosystem/sandboxes/modal/), [Cloudflare Sandbox](/docs/ecosystem/sandboxes/cloudflare/), and [Cloudflare Shell](/docs/ecosystem/sandboxes/cloudflare-shell/) — see [Sandboxes in the Ecosystem](/docs/ecosystem/#sandboxes). For an unsupported provider, run `flue add sandbox <docs-url>` and your coding agent can build the adapter against the [Sandbox Adapter API](/docs/reference/sandbox-api/).

Adapters are deliberately thin: your application creates, reuses, and deletes provider sandboxes; Flue only connects to what you hand it and never destroys provider infrastructure. The usual pattern wraps the provider call in the factory itself, so the sandbox is created (or reconnected) lazily at initialization:

```ts title="src/agents/code-runner.ts"
'use agent';
import { Daytona } from '@daytona/sdk';
import { useModel, useSandbox } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona.ts';

export function CodeRunner() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox({
    async createSessionEnv(options) {
      const client = new Daytona();
      const sandbox = await client.create();
      return daytona(sandbox).createSessionEnv(options);
    },
  });
  return 'Clone the repository the user names, run its test suite, and report results.';
}
```

`createSessionEnv({ id })` receives the agent instance id. A factory that looks up an existing provider sandbox by that id before creating one gives each conversation a durable workspace that survives across messages and process restarts.

### Sandbox-provided tools

A sandbox factory may also carry a `tools` function. When present, it **replaces** the framework's default model-facing tool set for that agent — the [Cloudflare Shell](/docs/ecosystem/sandboxes/cloudflare-shell/) adapter, for example, keeps the `read`/`write`/`edit` file tools but swaps the shell-backed `bash`/`grep`/`glob` for a `code` tool that executes JavaScript against a durable workspace. Adapters compose these sets from the exported per-tool factories (`createReadTool`, `createBashTool`, and friends) rather than rebuilding from scratch. Because capabilities vary this way, check an integration's documentation before assuming ordinary file or command tools are available. See the [Sandbox Adapter API](/docs/reference/sandbox-api/) for the contract.

## Conditional attachment

Like other hooks, `useSandbox()` may be called conditionally — an agent can legally gain or lose its sandbox mid-conversation. Gate the call on [persistent state](/docs/guide/agent-hooks/#persisted-state) and let a tool flip it:

```ts title="src/agents/support-engineer.ts"
'use agent';
import { useModel, usePersistentState, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function SupportEngineer() {
  useModel('anthropic/claude-sonnet-4-6');
  const [investigating, setInvestigating] = usePersistentState('investigating', false);

  useTool({
    name: 'open_investigation',
    description: 'Call when the issue needs hands-on debugging in the repository.',
    async run() {
      setInvestigating(true);
      return 'Investigation opened. The repository workspace will be attached.';
    },
  });

  if (investigating) {
    useSandbox(local({ cwd: '/srv/support/repro' }));
  }

  return investigating
    ? 'Reproduce the issue in the workspace and report your findings.'
    : 'Diagnose the issue from the conversation. Open an investigation when you need hands-on debugging.';
}
```

Presence of the `useSandbox()` call is read at initialization and again at every turn boundary. When it flips, the environment swaps before the next model call: attaching resolves the declared factory, and detaching removes the environment — the file and shell tools drop with it, and nothing carries over either way. The model is told about the swap with a single `environment` signal in the conversation that restates the complete current state — the new working directory plus the full tool, skill, and subagent rosters — and warns that files and results from the previous environment may no longer be accessible (see [Dynamic resources](/docs/reference/agent-api/#dynamic-resources)).

The system prompt stays frozen: it keeps describing the workspace discovered at initialization until the next [compaction](/docs/reference/agent-hooks-api/#compactionconfig), which re-discovers against the current environment.

Only _presence_ is observable: factories are fresh objects on every render, so replacing sandbox A with sandbox B while staying attached doesn't swap mid-run — it takes effect when the next submission initializes. And because the condition lives in persistent state, it replays durably: every later submission re-attaches the same declaration, and an adapter keyed on the instance id resolves back to the same workspace.

## Next steps

- [Agent Hooks](/docs/guide/agent-hooks/) — the hook model `useSandbox()` participates in.
- [Agent API](/docs/reference/agent-api/) — the full `useSandbox(...)` and `harness.sandbox` contracts.
- [Sandbox Adapter API](/docs/reference/sandbox-api/) — build an adapter for your own sandbox provider.
- [Ecosystem: Sandboxes](/docs/ecosystem/#sandboxes) — the catalog of supported providers.
- [Node.js target](/docs/guide/node-target/#local-sandbox) — the `local()` reference and host deployment.
- [Cloudflare target](/docs/guide/cloudflare-target/#cloudflare-sandbox) — container-backed sandboxes on Workers.
- [Durability](/docs/guide/durability/#keep-workspace-state-separate) — conversation persistence and workspace persistence are independent choices.
