> **Experimental** — Flue is under active development. APIs may change.
>
> Looking for `v0.0.x`? [See here.](https://github.com/withastro/flue/tree/v0.0.x)

# Flue

Flue is **The Agent Harness Framework**: a TypeScript framework for building headless agents that feel like Claude Code, Codex, OpenCode, or Pi, but run as programmable server actions.

An app has three core pieces:

- **Actions are handlers.** Flue scans `actions/` or `.flue/actions/` and turns each handler into a runnable action.
- **Agents are values.** Use `defineAgent()` when instructions, tools, skills, or subagents should travel together as an explicit reusable definition.
- **Harnesses and sessions run work.** An action calls `init()`, opens a session, then uses `prompt()`, `skill()`, `task()`, or `shell()`.

Skills and tools can be bundled into an agent definition at build time. Sandbox files are different: Flue only reads sandbox `AGENTS.md` / `CLAUDE.md` and `.agents/skills/` when an action explicitly opts into `loadFromSandbox`.

## Packages

| Package | Description |
| --- | --- |
| [`@flue/runtime`](packages/runtime) | Runtime APIs for actions, agents, harnesses, sessions, tools, and sandboxes |
| [`@flue/cli`](packages/cli) | Build, dev, run, logs, init, add, and config tooling |

## Getting started

Install Flue, create a project config, and create an action directory:

```bash
npm install @flue/runtime valibot
npm install -D @flue/cli
npx flue init --target node
mkdir -p actions
```

```ts
// actions/hello.ts
import type { ActionContext } from '@flue/runtime';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init, payload }: ActionContext) {
  const harness = await init({ model: 'anthropic/claude-sonnet-4-6' });
  const session = await harness.session();
  const { data } = await session.prompt(`Translate this to ${payload.language}: "${payload.text}"`, {
    result: v.object({ translation: v.string() }),
  });
  return data;
}
```

Run it locally:

```bash
ANTHROPIC_API_KEY=... npx flue dev --target node
curl http://localhost:3583/actions/hello/demo \
  -H 'Content-Type: application/json' \
  -d '{"text":"Hello world","language":"French"}'
```

`hello` is the Action name. `demo` is the ActionInstance id; reusing it resumes that action instance's persisted harness/session state within the backing runtime/store. Each invocation creates a new Run, whose run id is used by `flue logs <runId>`.

## Project layout

Flue scans exactly one directory for handlers:

```txt
actions/            # bare layout
.flue/actions/      # source layout when .flue/ exists
```

If `.flue/` exists, Flue reads `.flue/actions/` and ignores bare `actions/`. Every other folder is convention only: `agents/`, `tools/`, `skills/`, and `connectors/` may live wherever your imports point.

## Agents as values

Inline `init({ model })` is the simplest path. Use `defineAgent()` when the definition should be named, reusable, or carry bundled behavior.

```ts
import { defineAgent, type ActionContext } from '@flue/runtime';

const reviewer = defineAgent({
  name: 'reviewer',
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Review the request carefully and answer concisely.',
});

export default async function ({ init, payload }: ActionContext) {
  const harness = await init({ agent: reviewer });
  const session = await harness.session();
  return await session.prompt(payload.prompt);
}
```

## Bundled tools

`defineTool()` creates tool values. Put them on an agent to make them available to every call in its sessions, or pass them to an individual prompt for call-scoped access.

```ts
import { Type, defineAgent, defineTool } from '@flue/runtime';

const uppercase = defineTool({
  name: 'uppercase',
  description: 'Convert text to uppercase.',
  parameters: Type.Object({ text: Type.String() }),
  execute: async (args) => String(args.text).toUpperCase(),
});

const agent = defineAgent({
  name: 'editor',
  model: 'anthropic/claude-sonnet-4-6',
  tools: [uppercase],
});
```

## Bundled skills

Skills are spec-compliant directories with `SKILL.md` at the root:

```txt
.agents/skills/summarize/
  SKILL.md
  references/
  scripts/
  assets/
```

```md
---
name: summarize
description: Summarize supplied text.
---

Return a concise summary of the provided material.
```

Import a skill with the `skill` import attribute and attach it to an agent:

```ts
import { defineAgent } from '@flue/runtime';
import summarize from '../.agents/skills/summarize/SKILL.md' with { type: 'skill' };

const agent = defineAgent({
  name: 'summarizer',
  model: 'anthropic/claude-sonnet-4-6',
  skills: [summarize],
});

const result = await session.skill(summarize, { args: { text } });
```

The value form is ideal for bundled skills. String names remain supported, especially for sandbox-discovered skills.

## Subagents and tasks

Declare subagents directly on the parent agent. Programmatic delegation uses `session.task(..., { agent })`; agents with declared subagents also receive a model-facing `task` tool.

```ts
const researcher = defineAgent({
  name: 'researcher',
  model: 'anthropic/claude-haiku-4-5',
  instructions: 'Return concise findings.',
});

const lead = defineAgent({
  name: 'lead',
  model: 'anthropic/claude-sonnet-4-6',
  subagents: [researcher],
});

const result = await session.task('Investigate this issue.', { agent: researcher });
```

## Sandbox context and runtime-discovered skills

By default, Flue does not read context or skills from the sandbox. Opt in when an action operates inside a repo or hydrated workspace:

```ts
const harness = await init({
  agent,
  sandbox,
  cwd: '/workspace/project',
  loadFromSandbox: true,
});
```

`true` reads conventional locations under `cwd`:

- `AGENTS.md`, falling back to `CLAUDE.md`
- `.agents/skills/*/SKILL.md`

Explicit path mode is selective. Each object field enables only that branch:

```ts
loadFromSandbox: { skills: '/repo/.agents/skills' }
loadFromSandbox: { context: '/repo/AGENTS.md' }
loadFromSandbox: { skills: '/repo/.agents/skills', context: '/repo/AGENTS.md' }
```

Inline `init({ context: '...' })` adds invocation-specific workspace markdown after agent instructions.

## Sandboxes

Without `sandbox`, Flue uses a fast in-memory sandbox. Node apps can use the built-in host sandbox from `@flue/runtime/node`; remote or Cloudflare-specific sandboxes come from connector guidance installed with `flue add`.

```bash
flue add daytona --print
flue add cloudflare-shell --print
```

For example, a Node CI action can pass the built-in local sandbox factory:

```ts
import { local } from '@flue/runtime/node';

const harness = await init({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: local({ env: { GH_TOKEN: process.env.GH_TOKEN } }),
  loadFromSandbox: true,
});
```

## CLI

```bash
flue dev --target node
flue build --target node
flue run hello --target node --id demo --payload '{"text":"Hello"}'
flue logs <runId>
```

`flue.config.ts` can set `target`, `root`, and `output`:

```ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({ target: 'node' });
```

## Cloudflare

Cloudflare builds support Workers AI models such as `cloudflare/@cf/moonshotai/kimi-k2.6`. Add an `AI` binding in `wrangler.jsonc`; no provider API key is needed for that model path. Cloudflare targets require action filenames to use lower-kebab-case so route names and generated Durable Object classes stay portable.

Cloudflare shell workspace examples live in [`examples/cloudflare`](examples/cloudflare). They show R2/git hydration followed by `loadFromSandbox: true` discovery inside the workspace.

## Examples

- [`examples/hello-world`](examples/hello-world) covers inline actions, defined agents, bundled tools, bundled skills, subagents, sandbox loading, sessions, and result schemas.
- [`examples/cloudflare`](examples/cloudflare) covers Workers AI plus Cloudflare workspace hydration.
- [`examples/sentry`](examples/sentry) shows global event observation for error reporting.
