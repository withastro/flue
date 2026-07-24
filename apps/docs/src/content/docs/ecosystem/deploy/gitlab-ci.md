---
title: Build Agents for GitLab CI/CD
description: Build and run Flue agents in GitLab CI/CD pipelines.
lastReviewedAt: 2026-07-21
---

Build and run Flue agents in GitLab CI/CD pipelines. This guide walks you through creating your first agent, running it locally with the CLI, and wiring it into a pipeline.

By the end, you will have a Flue agent running inside GitLab CI/CD, and you will know how to use local sandbox context, external CLIs, subagents, skills, and typed results to build CI automations.

CI is `flue run`'s home turf: one agent module, one message, no server, no port. The command executes the agent transport-free and prints the reply to stdout, so a pipeline step can pipe it anywhere.

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

```typescript title="src/agents/hello.ts"
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function Hello() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  return 'Greet the person the user names and share an interesting fact.';
}
```

A few things to note:

- This agent is never mounted over HTTP — it exists to be run from the CLI, which is perfect for CI. (The `'use agent'` directive matters only for building a deployable app with Vite; `flue run` takes the module path directly.)
- **`local()`** — The `local()` sandbox runs the agent directly against the host filesystem and shell. In CI, that's the checked-out repo plus whatever binaries are on `$PATH` (`glab`, `git`, `npm`, etc.). Skills and `AGENTS.md` are discovered automatically from the project root. By default only shell-essential env vars (`PATH`, `HOME`, locale, etc.) are inherited from `process.env` — pass `local({ env: { GITLAB_TOKEN: process.env.GITLAB_TOKEN } })` to expose more. Use `local()` only when the runner itself provides the isolation boundary.

### 3. Test it locally

```bash
npx flue run src/agents/hello.ts --message "Say hello to World"
```

`flue run` executes the agent module in-process — no HTTP listener, no build — streams progress to stderr, and prints the final reply to stdout. Pass `--json` for a machine-readable envelope instead.

### 4. Wire it into GitLab CI/CD

`.gitlab-ci.yml`:

```yaml
hello:
  image: node:22
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger" && $ISSUE_ACTION == "open"
  before_script:
    - npm ci
  script:
    - |
      npx flue run src/agents/hello.ts \
        --message "Say hello to $ISSUE_AUTHOR"
```

#### Triggering pipelines from issue events

GitLab doesn't pass issue data into CI variables automatically. You need a [pipeline trigger](https://docs.gitlab.com/ee/ci/triggers/) to bridge the gap:

1. Create a pipeline trigger token: **Settings > CI/CD > Pipeline trigger tokens**
2. Add a project webhook (**Settings > Webhooks**) that fires on **Issue events**, pointing at a small relay that calls the trigger API with the right variables:

```typescript
// Deploy as a serverless function or lightweight server
async function handleGitLabWebhook(event) {
  const { object_kind, object_attributes, issue } = event;
  let variables: Record<string, string> = {};

  if (object_kind === 'issue') {
    variables = {
      ISSUE_ACTION: object_attributes.action,
      ISSUE_IID: String(object_attributes.iid),
      ISSUE_AUTHOR: object_attributes.author?.username ?? '',
    };
  } else if (object_kind === 'note' && issue) {
    variables = {
      ISSUE_ACTION: 'note',
      ISSUE_IID: String(issue.iid),
    };
  } else {
    return;
  }

  await fetch(`${GITLAB_URL}/api/v4/projects/${PROJECT_ID}/trigger/pipeline`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token: TRIGGER_TOKEN, ref: 'main', variables }),
  });
}
```

Once wired up, open an issue and you'll see a passing pipeline with the agent's greeting in the logs.

## Building a real agent

Now let's build something useful — an issue triage agent that analyzes an issue and reports back. This is where Flue's agent features start to shine.

### Structured work with skills and actions

An agent's deterministic orchestration lives in [harness tools](/docs/guide/tools/#harness-tools) — finite, schema-validated jobs the model calls — and [skills](/docs/guide/skills/), reusable instruction files. Inside either, the harness gives you two core methods:

- **`harness.sandbox.exec(cmd)`** — Run a shell command in the sandbox. Returns `{ stdout, stderr, exitCode }`.
- **`harness.prompt(text, opts)`** — Send a prompt to the agent and get back a result. `harness.prompt(...)` runs in the same conversation context as the agent's own turns, so naming a mounted skill in the instruction is enough to direct the model to apply it.

`prompt()` accepts a `result` option — a [Valibot](https://valibot.dev) schema that defines the expected output shape. Flue parses the agent's response and returns it on `response.data`, fully typed:

```typescript
import * as v from 'valibot';

// summary: string
const { data: summary } = await harness.prompt(`Summarize this diff:\n${diff}`, {
  result: v.string(),
});

// diagnosis: { reproducible: boolean, skipped: boolean }
const { data: diagnosis } = await harness.prompt(
  `Apply the triage skill to issue !${issueIid}:\n\n${issue}`,
  {
    result: v.object({
      reproducible: v.boolean(),
      skipped: v.boolean(),
    }),
  },
);
```

### Connecting external CLIs

Your agent often needs to interact with external tools. With `local()`, the agent's bash tool runs against the host shell directly — anything on `$PATH` is reachable. Host env vars are opt-in: only shell essentials (`PATH`, `HOME`, locale, etc.) are inherited by default, so you pass the specific vars your CLIs need via `local({ env: { ... } })`.

In GitLab CI, this means you set the secrets you want the agent's CLIs to see in the job's `variables:` block (or as masked CI/CD variables), then forward them explicitly into the sandbox. The runner is your isolation boundary; flue makes the inner boundary (host → spawned shell) explicit.

```typescript title="src/agents/triage.ts"
import { useModel, useSandbox } from '@flue/runtime';
import { local } from '@flue/runtime/node';

export function Triage() {
  useModel('anthropic/claude-opus-4-7');
  useSandbox(
    local({
      env: { GITLAB_TOKEN: process.env.GITLAB_TOKEN },
    }),
  );
  return 'When given an issue IID, run the `triage` skill on it and report severity, reproducibility, and a summary.';
}
```

If you want a tighter boundary — the agent can call a specific operation but never see the underlying token — call `useTool(...)` inside the agent function. The tool implementation reads the secret from `process.env`; the agent only sees the tool's parameters and result.

### Subagents

Named subagents can run focused detached tasks. `useSubagent(...)` declares one, backed by its own agent function:

```typescript title="src/agents/triage.ts"
'use agent';
import { useModel, useSubagent } from '@flue/runtime';

function Reviewer() {
  return 'Focus on correctness, security, and project standards.';
}

export function Triage() {
  useSubagent({
    name: 'reviewer',
    description: 'Reviews a merge request for correctness, security, and project standards.',
    agent: Reviewer,
  });
  return 'Delegate MR reviews to the `reviewer` subagent via a task.';
}
```

### Sandbox context

The agent reads `AGENTS.md` and skills from its sandbox at runtime. CI agents typically use `local()`, which gives direct access to the runner's checkout — so any files in your repo are visible automatically.

**Skills** are reusable agent tasks defined as markdown files in `.agents/skills/`. They give the agent a focused instruction set for a specific job:

`.agents/skills/triage/SKILL.md`:

```markdown
---
name: triage
description: Triage a GitLab issue — reproduce, assess severity, and optionally fix.
---

Given the issue IID and project ID in the arguments:

1. Use `glab issue view <iid>` to fetch the issue details
2. Read the codebase to understand the relevant area
3. Attempt to reproduce the issue
4. Assess severity and write a summary
5. If the fix is straightforward, apply it and push a branch
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

### Wiring it into GitLab CI/CD

`.gitlab-ci.yml`:

```yaml
triage:
  image: node:22
  timeout: 30 minutes
  rules:
    - if: $CI_PIPELINE_SOURCE == "trigger" && $ISSUE_ACTION == "open"
  before_script:
    - npm ci
  script:
    - |
      npx flue run src/agents/triage.ts \
        --message "Triage issue !$ISSUE_IID in project $CI_PROJECT_ID"
```

Add these as CI/CD variables (**Settings > CI/CD > Variables**, masked):

| Variable            | Description                                       |
| ------------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | API key for your LLM provider                     |
| `GITLAB_API_TOKEN`  | Project or personal access token with `api` scope |

## Typed results and orchestration

Result schemas aren't just for type safety — they're how you orchestrate multi-step work. Wrap the orchestration in a harness-connected tool (`useTool({ harness: true })`): you get typed data back from `prompt()` and can branch on it in plain code, all inside one durable conversation:

```typescript title="src/agents/auto-triage.ts"
'use agent';
import { useModel, useSandbox, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import * as v from 'valibot';

export function AutoTriage() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useTool({
    name: 'triage-issue',
    description: 'Triage one GitLab issue and auto-fix critical reproducible ones.',
    input: v.object({ issueIid: v.number() }),
    harness: true,
    async run({ harness, data }) {
      const { data: triage } = await harness.prompt(
        `Apply the triage skill to issue !${data.issueIid}.`,
        {
          result: v.object({
            severity: v.picklist(['low', 'medium', 'high', 'critical']),
            reproducible: v.boolean(),
            summary: v.string(),
          }),
        },
      );

      if (triage.severity === 'critical' && triage.reproducible) {
        await harness.prompt(`Apply the auto-fix skill to issue !${data.issueIid}.`, {
          result: v.object({ fix_applied: v.boolean(), branch: v.optional(v.string()) }),
        });
      }
      return triage;
    },
  });
  return 'When given an issue IID, call the `triage-issue` tool and report its result.';
}
```

This pattern — prompt, check the result, decide what to do next — is how you build sophisticated agents that go beyond single-shot prompts.

## Running agents locally

During development, `flue run` executes the same module the pipeline step will run:

```bash
# One-shot run
npx flue run src/agents/auto-triage.ts --message "Triage issue !42"

# Machine-readable output for scripting
npx flue run src/agents/auto-triage.ts --message "Triage issue !42" --json | jq -r '.message'

# Continue the same conversation across invocations
npx flue run src/agents/auto-triage.ts --message "What did you conclude?" --id issue-42
```

Progress streams to stderr; only the final reply (or the `--json` envelope) lands on stdout. See [`flue run`](/docs/cli/run/) for the full contract.
