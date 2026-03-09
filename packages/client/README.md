# @flue/client

AI-powered workflows for your codebase, built on [OpenCode](https://opencode.ai).

## Install

```bash
bun install @flue/client
npm install @flue/client
pnpm install @flue/client
```

## Usage

```ts
// .flue/workflows/issue-triage.ts
import type { FlueClient } from '@flue/client';

export default async function triage(flue: FlueClient, args: { issueNumber: number }) {
  const issue = await flue.shell(`gh issue view ${args.issueNumber} --json title,body`);
  const result = await flue.skill('triage/diagnose.md', {
    args: { issueNumber: args.issueNumber },
  });
  const comment = await flue.prompt(`Summarize the triage for: ${issue.stdout}`);
  await flue.shell(`gh issue comment ${args.issueNumber} --body-file -`, { stdin: comment });
}
```

## API

### `flue.shell(command, options?)`

Run a shell command in the target environment. Returns `{ stdout, stderr, exitCode }`.

```ts
const result = await flue.shell('pnpm test');
const result = await flue.shell('cat -', { stdin: 'hello' });
await flue.shell('pnpm test', { throwOnError: true });
```

Options: `env`, `stdin`, `cwd`, `timeout`, `throwOnError`

### `flue.skill(name, options?)`

Delegate a task to an AI agent using a skill file from `.agents/skills/`. The agent reads the skill instructions and works autonomously.

```ts
// Fire-and-forget (no return value)
await flue.skill('triage/reproduce.md', { args: { issueNumber: 123 } });

// With a typed result (via Valibot schema)
const result = await flue.skill('triage/diagnose.md', {
  result: v.object({ confidence: v.picklist(['high', 'medium', 'low']) }),
});
```

Options: `args`, `result`, `model`

### `flue.prompt(text, options?)`

Send a one-off prompt to an AI agent. Like `skill()` but inline — no skill file needed.

```ts
await flue.prompt('Refactor the tests in src/utils/ to use vitest');

const summary = await flue.prompt('Summarize these test failures: ...', {
  result: v.string(),
});
```

Options: `result`, `model`

## Proxies (Sandbox Mode)

In sandbox mode, the AI agent runs inside a sandbox container with no access to sensitive host credentials. Proxies let the sandbox talk to external services without leaking any actual credentials into the sandbox.

Flue ships with built-in presets for popular services. Every proxy supports an access control policy (`policy`) option for advanced control over what the sandbox has access to do. Built-in levels like `'allow-read'` and `'allow-all'` cover common service-specific policy rules, and you can extend them with explicit allow/deny rules for fine-grained control:

```ts
import { anthropic, github } from '@flue/client/proxies';

export const proxies = {
  anthropic: anthropic(),
  github: github({
    policy: {
      base: 'allow-read',
      allow: [{ method: 'POST', path: '/repos/withastro/astro/issues/*/comments', limit: 1 }],
    },
  }),
};
```
