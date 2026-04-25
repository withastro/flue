# Build Agents for GitHub Actions

Build and run Flue agents in GitHub Actions. This guide walks you through creating your first agent, running it locally with the CLI, and wiring it into a CI workflow.

## Hello World

A minimal agent that runs in CI whenever an issue is opened.

### 1. Set up your project

```bash
mkdir my-flue-project && cd my-flue-project
npm init -y
npm install @flue/sdk valibot
npm install -D @flue/cli
```

### 2. Create your first agent

`.flue/agents/hello.ts`:

```typescript
import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = {};

export default async function ({ init, payload }: FlueContext) {
  const session = await init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });

  const result = await session.prompt(
    `Say hello to ${payload.name ?? 'the user'} and share an interesting fact.`,
    {
      result: v.object({
        greeting: v.string(),
        fact: v.string(),
      }),
    },
  );

  return result;
}
```

A few things to note:

- **`triggers = {}`** — This agent has no HTTP trigger. It's designed to be run from the CLI, which is perfect for CI.
- **`model`** — Every session needs a model. If you do not pass one to `init()` or a specific `prompt()` / `skill()` call, no model is chosen.
- **`sandbox: 'local'`** — The `"local"` sandbox mounts the host filesystem at `/workspace`. In CI, this is the checked-out repo. Skills and `AGENTS.md` are discovered automatically from the workspace directory.
- **Result schemas** — The [Valibot](https://valibot.dev) schema defines the expected output shape. Flue parses the agent's response and returns a typed object.

### 3. Test it locally

```bash
npx flue run hello --target node --session-id test-1 \
  --payload '{"name": "World"}'
```

`flue run` builds the workspace, starts a temporary server, invokes the agent, streams progress to stderr, and prints the final result as JSON to stdout. This is the fastest way to iterate on an agent — no deployment needed.

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
        run: |
          npx flue run hello --target node --session-id "hello-${{ github.event.issue.number }}" \
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

Both `prompt()` and `skill()` accept a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the agent's response and returns a typed object:

```typescript
import * as v from 'valibot';

// const summary: string
const summary = await session.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// const diagnosis: { reproducible: boolean, skipped: boolean }
const diagnosis = await session.skill('triage', {
  args: { issueNumber, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Connecting external CLIs with commands

In CI, your agent often needs to interact with tools like `gh`, `npm`, or `git`. But you don't want to hand the agent your raw API keys. **Commands** solve this — they let you connect privileged CLIs to the agent without leaking secrets.

Secrets are hooked up inside the command definition, so the agent never sees them. Commands are granted per-prompt or per-skill, so you can be as granular with access as you need. Here's a triage agent that puts it all together:

`.flue/agents/triage.ts`:

```typescript
import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

export const triggers = {};

// Connect privileged CLIs to your agent without leaking sensitive keys.
// Secrets are hooked up inside the command definition here, so the agent
// never sees them. The default env forwards safe vars like PATH and HOME —
// anything else (tokens, keys) must be opted in explicitly.
const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });
const npm = defineCommand('npm');

export default async function ({ init, payload }: FlueContext) {
  const session = await init({ sandbox: 'local', model: 'anthropic/claude-opus-4-7' });

  const result = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    // Grant access to `gh` and `npm` for the life of this skill.
    commands: [gh, npm],
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
      fix_applied: v.boolean(),
    }),
  });

  return result;
}
```

The agent can now use `gh issue view`, `gh issue comment`, etc. through the command — but it never has access to the `GH_TOKEN` itself. If the agent tries to run `gh` outside of a prompt where it was granted, the command is blocked.

### Skills and roles

**Skills** are reusable agent tasks defined as markdown files. They live in `.agents/skills/` and give the agent a focused instruction set for a specific job:

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

**Roles** are agent personas that shape behavior across prompts. They live in `.flue/roles/`:

`.flue/roles/reviewer.md`:

```markdown
---
description: A careful code reviewer focused on correctness and security
---

You are a senior code reviewer. Focus on correctness, security implications,
and adherence to the project's coding standards. Be direct and specific in
your feedback.
```

Use a role by passing it to `prompt()`:

```typescript
const review = await session.prompt(`Review this PR:\n${diff}`, {
  role: 'reviewer',
  result: v.object({ approved: v.boolean(), comments: v.array(v.string()) }),
});
```

### The AGENTS.md file

`AGENTS.md` at the root of your workspace is the agent's system prompt — it provides global context about the project. When using `sandbox: 'local'`, Flue discovers this file automatically from the workspace directory:

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
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Run triage agent
        env:
          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          npx flue run triage --target node \
            --session-id "triage-${{ github.event.issue.number }}" \
            --payload '{"issueNumber": ${{ github.event.issue.number }}}'
```

The `--payload` flag passes JSON data to the agent's `payload` property. `GITHUB_TOKEN` is provided automatically by GitHub Actions.

## Typed results and orchestration

Result schemas aren't just for type safety — they're how you orchestrate multi-step workflows. Because you get typed data back from `prompt()` and `skill()`, you can branch on results within a single agent:

```typescript
import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

const gh = defineCommand('gh', { env: { GH_TOKEN: process.env.GH_TOKEN } });
const npm = defineCommand('npm');

export default async function ({ init, payload }: FlueContext) {
  const session = await init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });

  const diagnosis = await session.skill('triage', {
    args: { issueNumber: payload.issueNumber },
    commands: [gh],
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
    }),
  });

  if (diagnosis.severity === 'critical' && diagnosis.reproducible) {
    // Escalate: attempt an automated fix
    await session.skill('auto-fix', {
      args: { issueNumber: payload.issueNumber },
      commands: [gh, npm],
      result: v.object({ fix_applied: v.boolean(), pr_url: v.optional(v.string()) }),
    });
  }

  return diagnosis;
}
```

This pattern — prompt or skill call, check the result, decide what to do next — is how you build sophisticated agents that go beyond single-shot prompts.

## Running agents locally

During development, `flue run` is your main tool. It builds the workspace and runs the agent in one step:

```bash
# Run with a payload
npx flue run triage --target node --session-id test-1 \
  --payload '{"issueNumber": 42}'

# Pipe the result to jq
npx flue run triage --target node --session-id test-2 \
  --payload '{"issueNumber": 42}' | jq '.severity'
```

The CLI builds your workspace, starts a temporary server, invokes the agent via SSE, streams progress to stderr, and prints the final result to stdout. The `--session-id` flag identifies the session — use a consistent ID to resume a previous session, or a unique one for a fresh start.
