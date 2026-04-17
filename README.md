# flue

> **Experimental** — Flue is under active development. APIs may change.

Agent framework where agents are directories compiled into deployable server artifacts.

## Packages

| Package                     | Description                             |
| --------------------------- | --------------------------------------- |
| [`@flue/sdk`](packages/sdk) | Core SDK: build system, sessions, tools |
| [`@flue/cli`](packages/cli) | CLI for building and running agents     |

## Example

```ts
// .flue/agents/triage.ts
import { defineCommand, type FlueRuntime } from '@flue/sdk/client';
import * as v from 'valibot';

// Agent config:
// - `filesystem: 'local'` — agent operates on the real filesystem (for CI/deploy).
//   Without this, agents use an isolated in-memory overlay (safe by default).
// - `triggers` — how the agent is invoked (webhook, cron).
export const config = {
  filesystem: 'local',
  triggers: { webhook: true },
};

// Every agent exports a default handler function. For this "triage" agent, we
// accept the direct GitHub webhook for the "issues" and "issue_comment" events.
export default async function (flue: FlueRuntime, payload: any) {
  // Sessions are persistent conversations with resumable message history.
  // We'll pick back up this same session for the full lifecycle of an issue.
  const session = await flue.session(`issue-${payload.issue.number}`);

  // Sessions store metadata, which you can use to track session state.
  if (session.metadata.resolved) {
    return { status: 'already-resolved' };
  }

  const prompt =
    payload.action === 'opened'
      ? `New issue: ${payload.issue.title}\n\n${payload.issue.body}`
      : `New update on issue: ${payload.issue.title}\n\n${payload.issue.body}`;

  // session.prompt() sends a message to the agent. The agent uses its
  // tools (bash, read, write, edit, grep, glob) plus any commands you
  // provide to complete the task.
  const result = await session.prompt(prompt, {
    // Define custom CLI commands that are allowed in the sandbox, outside of the normal
    // utilities. Environment variables are passed such that the agent never sees them.
    // External commands are scoped per-prompt. The next prompt won't have access.
    commands: [
      defineCommand('gh', { env: { GH_TOKEN: process.env.GITHUB_TOKEN } }),
      defineCommand('bgproc'),
      defineCommand('agent-browser'),
    ],
    // Structured output! `result` returns a typed JSON object.
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      summary: v.string(),
      reproducible: v.boolean(),
    }),
  });

  if (result.reproducible === true) {
    session.metadata.resolved = true;
  }

  return result;
}
```

```bash
# Build and run an agent in one step, good for testing and CI.
flue run triage --payload '{"action": "opened", "issue": {"number": 1, "title": "Bug", "body": "..."}}'

# Or, build the server and deploy it (Node supported, Cloudflare coming soon).
flue build
node dist/server.mjs  # serves all webhook-enabled agents via HTTP
```
