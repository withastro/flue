---
title: Build Agents for GitHub Actions
description: Build and run Flue agents in GitHub Actions.
---

Build and run Flue agents in GitHub Actions. This guide walks you through creating your first agent, running it locally with the CLI, and wiring it into a CI workflow.

By the end, you will have a Flue agent running inside GitHub Actions, and you will know how to use local sandbox context, external CLIs, subagents, skills, and typed results to build CI workflows.

## Hello World

A minimal agent that runs in CI whenever an issue is opened.

### 1. Set up your project

```bash
mkdir my-flue-project && cd my-flue-project
npm init -y
npm install @flue/runtime valibot
npm install -D @flue/cli
```

### 2. Create your first agent

`.flue/workflows/hello.ts`:

```typescript
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

const agent = createAgent(() => ({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' }));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(agent);
  const session = await harness.session();

  const { data } = await session.prompt(
    `Say hello to ${payload.name ?? 'the user'} and share an interesting fact.`,
    {
      result: v.object({
        greeting: v.string(),
        fact: v.string(),
      }),
    },
  );

  return data;
}
```

A few things to note:

- This workflow omits a public `route` handler, so it is internal-only and designed to be run from the CLI, which is perfect for CI.
- **`model`** — `init(agent)` fails unless the created agent config provides a model, sets `model: false`, or supplies a profile with a model.
- **`local()`** — The `local()` sandbox runs the agent directly against the host filesystem and shell. In CI, that's the checked-out repo plus whatever binaries are on `$PATH` (`gh`, `git`, `npm`, etc.). Skills and `AGENTS.md` are discovered automatically from the project root. By default only shell-essential env vars (`PATH`, `HOME`, locale, etc.) are inherited from `process.env` — pass `local({ env: { GH_TOKEN: process.env.GH_TOKEN } })` to expose more. Use `local()` only when the runner itself provides the isolation boundary.
- **Schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed.

### 3. Test it locally

```bash
npx flue run hello --target node \
  --payload '{"name": "World"}'
```

`flue run` builds the project, invokes the workflow through a private local child-process communication, streams progress to stderr, and prints the final result as JSON to stdout. The workflow does not need public transport exposure for this local command.

### 4. Wire it into GitHub Actions

`.github/workflows/hello.yml`:

```yaml
name: Hello Flue

on:
  issues:
    types: [opened]

jobs:
  hello:
    runs-on: ubuntu-latest
    permissions:
      issues: read
    steps:
      # actions/checkout v6.0.3
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
      # actions/setup-node v6.4.0
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
        with:
          node-version: 22
      - run: npm ci
      - name: Run agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx flue run hello --target node \
            --payload '{"name": "${{ github.event.issue.user.login }}"}'
```

Add `ANTHROPIC_API_KEY` as a repository secret (**Settings > Secrets and variables > Actions**). Open an issue and you'll see the agent's greeting in the job logs.

## Building a real agent

Now let's build something useful — an issue triage agent that analyzes an issue and reports back. This is where Flue's agent features start to shine.

### The agent handler

The agent handler is where orchestration lives. The `FlueContext` gives you everything you need: `init()` to create a session, `payload` for input data, and `env` for environment bindings.

Once you have a session, you have three core methods:

- **`session.shell(cmd)`** — Run a shell command in the sandbox. Returns `{ stdout, stderr, exitCode }`.
- **`session.prompt(text, opts)`** — Send a prompt to the agent and get back a result.
- **`session.skill(name, opts)`** — Run a named skill — a reusable agent task defined by a markdown instruction file.

Both `prompt()` and `skill()` accept a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed:

```typescript
import * as v from 'valibot';

// summary: string
const { data: summary } = await session.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// diagnosis: { reproducible: boolean, skipped: boolean }
const { data: diagnosis } = await session.skill('triage', {
  args: { issueNumber, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Connecting external CLIs

Your agent often needs to interact with tools like `gh`, `npm`, or `git`. With `local()`, the agent's bash tool runs against the host shell directly — anything on `$PATH` is reachable. Host env vars are opt-in: only shell essentials (`PATH`, `HOME`, locale, etc.) are inherited by default, so you pass the specific vars your CLIs need via `local({ env: { ... } })`.

In GitHub Actions, this means you set the secrets you want the agent's CLIs to see in the workflow `env:` block, then forward them explicitly into the sandbox. The runner is your isolation boundary; flue makes the inner boundary (host → spawned shell) explicit.

`.flue/workflows/triage.ts`:

```typescript
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

const agent = createAgent(() => ({
  sandbox: local({
    env: {
      GH_TOKEN: process.env.GH_TOKEN,
      NPM_TOKEN: process.env.NPM_TOKEN,
    },
  }),
  model: 'anthropic/claude-opus-4-7',
}));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(agent);
  const session = await harness.session();

  // The agent's bash tool can run `gh issue view`, `npm install`, `git diff`
  // etc. directly. Only the env vars you forwarded above are visible to
  // those binaries.
  const { data } = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
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

If you want a tighter boundary — the agent can call a specific operation but never see the underlying token — return the custom tool from `createAgent(...)` with `tools: [...]`. The tool implementation reads the secret from `process.env`; the agent only sees the tool's parameters and result.

### Subagents

Named subagents can run focused detached tasks:

```typescript
const reviewer = defineAgentProfile({
  name: 'reviewer',
  instructions: 'Focus on correctness, security, and project standards.',
});
const agent = createAgent(() => ({ model: 'anthropic/claude-sonnet-4-6', subagents: [reviewer] }));
const harness = await init(agent);
const session = await harness.session();
const { data } = await session.task(`Review this PR:\n${diff}`, {
  agent: 'reviewer',
  result: v.object({ approved: v.boolean(), comments: v.array(v.string()) }),
});
```

### Sandbox context

The agent reads `AGENTS.md` and skills from its sandbox at runtime. CI agents typically use `local()`, which gives direct access to the runner's checkout — so any files in your repo are visible automatically.

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/triage/SKILL.md`:

```markdown
---
name: triage
description: Triage a GitHub issue — reproduce, assess severity, and optionally fix.
---

Given the issue number in the arguments:

1. Use `gh issue view` to fetch the issue details
2. Read the codebase to understand the relevant area
3. Attempt to reproduce the issue
4. Assess severity and write a summary
5. If the fix is straightforward, apply it and open a PR
```

**`AGENTS.md`** at your project root is the agent's system prompt — it provides global context about the project:

```markdown
You are a helpful assistant working on the my-project codebase.

## Project structure

- `src/` — Application source code
- `tests/` — Test suite

## Guidelines

- Always run tests before suggesting a fix is complete
- Use the project's existing patterns and conventions
```

### Wiring it into GitHub Actions

`.github/workflows/issue-triage.yml`:

```yaml
name: Issue Triage

on:
  issues:
    types: [opened]

jobs:
  triage:
    runs-on: ubuntu-latest
    timeout-minutes: 30
    permissions:
      contents: read
      issues: write
    steps:
      # actions/checkout v6.0.3
      - uses: actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10
      # actions/setup-node v6.4.0
      - uses: actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e
        with:
          node-version: 22
      - run: npm ci
      - name: Run triage agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx flue run triage --target node \
            --payload '{"issueNumber": ${{ github.event.issue.number }}}'
```

The `--payload` flag passes JSON data to the workflow's `payload` property. `GITHUB_TOKEN` is provided automatically by GitHub Actions.

## Typed results and orchestration

Result schemas aren't just for type safety — they're how you orchestrate multi-step workflows. Because you get typed data back from `prompt()` and `skill()`, you can branch on results within a single agent:

```typescript
import { createAgent, type FlueContext } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

const agent = createAgent(() => ({ sandbox: local(), model: 'anthropic/claude-sonnet-4-6' }));

export async function run({ init, payload }: FlueContext) {
  const harness = await init(agent);
  const session = await harness.session();

  const { data } = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
    }),
  });

  if (data.severity === 'critical' && data.reproducible) {
    // Escalate: attempt an automated fix
    await session.skill('auto-fix', {
      args: { issueNumber: payload.issueNumber },
      result: v.object({ fix_applied: v.boolean(), pr_url: v.optional(v.string()) }),
    });
  }

  return data;
}
```

This pattern — prompt or skill call, check the result, decide what to do next — is how you build sophisticated agents that go beyond single-shot prompts.

## Running workflows locally

During development, `flue run` is your main tool. It builds the project and runs the workflow in one step:

```bash
# Run with a payload
npx flue run triage --target node \
  --payload '{"issueNumber": 42}'

# Pipe the result to jq
npx flue run triage --target node \
  --payload '{"issueNumber": 42}' | jq '.severity'
```

The CLI builds your project root, invokes the workflow through a private local child-process communication, streams progress to stderr, and prints the final result to stdout.
