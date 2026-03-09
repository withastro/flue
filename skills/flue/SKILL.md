---
name: flue
description: Work with Flue, the sandbox agent framework for OpenCode. Use when asked to "install Flue", "set up Flue", "create a Flue workflow", "add a workflow", "deploy to GitHub Actions", or "run agents in CI".
---

# Flue

Help users install, configure, and work with Flue workflows. Flue connects a full OpenCode session to AI agents and CI workflows with secure, autonomous execution.

## Routing

Determine what the user needs and load the appropriate reference:

- **Install Flue / get started** — Read `${CLAUDE_SKILL_ROOT}/references/install.md`
- **Add sandbox isolation** — Read `${CLAUDE_SKILL_ROOT}/references/add-sandbox.md`
- **Create agent skills for workflows** — See https://agentskills.io/specification
- **Write or modify a workflow** — Use the API reference below
- **See example patterns** — Read `${CLAUDE_SKILL_ROOT}/references/patterns.md`

## FlueClient API

Workflows are TypeScript files in `.flue/workflows/` that export a default async function receiving a `FlueClient`. The client provides three core methods:

### `flue.shell(command, options?)`

Run shell commands in the target environment. Returns `{ stdout, stderr, exitCode }`.

```typescript
const result = await flue.shell('gh issue view 123 --json title,body');
const issue = JSON.parse(result.stdout);

// With stdin
await flue.shell('gh issue comment 123 --body-file -', { stdin: commentBody });

// Throw when the command exits non-zero
await flue.shell('pnpm test', { throwOnError: true });
```

**Options:** `env`, `stdin`, `cwd`, `timeout`, `throwOnError`

### `flue.prompt(text, options?)`

Send a one-off prompt to an LLM. Use for quick tasks like summarization, classification, or text generation.

```typescript
// Without result schema (fire-and-forget)
await flue.prompt('Refactor the tests in src/utils/ to use vitest');

// With typed result via Valibot schema
const summary = await flue.prompt('Categorize this issue: ' + issue.title, {
  result: v.picklist(['bug', 'feature', 'question']),
});
```

**Options:** `result` (Valibot schema), `model`, `timeout`

### `flue.skill(path, options?)`

Delegate a complex task to an autonomous agent using a skill file from `.agents/skills/`. The agent reads the skill instructions and works autonomously with full tool access.

```typescript
// Fire-and-forget
await flue.skill('triage/reproduce.md', {
  args: { issueNumber: 123 },
});

// With typed result validation
const diagnosis = await flue.skill('triage/diagnose.md', {
  args: { issueNumber: 123 },
  result: v.object({
    confidence: v.picklist(['high', 'medium', 'low']),
    reproducible: v.boolean(),
  }),
});
```

**Options:** `args`, `result` (Valibot schema), `model`, `timeout`

## Workflow File Structure

```typescript
import type { FlueClient } from '@flue/client';
import * as v from 'valibot';

// Optional: typed input args (validated by CLI via --args)
export const args = v.object({
  issueNumber: v.number(),
});

// Optional: proxy declarations for sandbox mode
export const proxies = {
  anthropic: anthropic(),
  github: github({ policy: 'allow-read' }),
};

// Required: default export function
export default async function myWorkflow(
  flue: FlueClient,
  { issueNumber }: v.InferOutput<typeof args>,
) {
  // ...
}
```

## CLI

```bash
# Run a workflow
npx flue run .flue/workflows/hello.ts
npx flue run .flue/workflows/triage.ts --args '{"issueNumber": 123}'
npx flue run .flue/workflows/triage.ts --model anthropic/claude-sonnet-4-20250514
npx flue run .flue/workflows/triage.ts --sandbox ghcr.io/org/repo/flue-sandbox:latest

# Install OpenCode CLI (for CI environments)
npx flue install
```

## Reference Files

- Installation & getting started: `${CLAUDE_SKILL_ROOT}/references/install.md`
- Adding sandbox isolation: `${CLAUDE_SKILL_ROOT}/references/add-sandbox.md`
- Common workflow patterns: `${CLAUDE_SKILL_ROOT}/references/patterns.md`
- Example workflow file: `${CLAUDE_SKILL_ROOT}/assets/hello-flue.ts`
- Example GitHub Actions workflow: `${CLAUDE_SKILL_ROOT}/assets/hello-flue.yml`
