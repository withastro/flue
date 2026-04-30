# Build Agents for GitLab CI/CD

Build and run Flue agents in GitLab CI/CD pipelines. This guide walks you through creating your first agent, running it locally with the CLI, and wiring it into a pipeline.

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
  const agent = await init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });
  const session = await agent.session();

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
npx flue run hello --target node --id test-1 \
  --payload '{"name": "World"}'
```

`flue run` builds the workspace, starts a temporary server, invokes the agent, streams progress to stderr, and prints the final result as JSON to stdout. This is the fastest way to iterate on an agent — no deployment needed.

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
      npx flue run hello --target node \
        --id "hello-$ISSUE_IID" \
        --payload "{\"name\": \"$ISSUE_AUTHOR\"}"
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
  args: { issueIid, issue },
  result: v.object({
    reproducible: v.boolean(),
    skipped: v.boolean(),
  }),
});
```

### Connecting external CLIs with commands

In CI, your agent often needs to interact with external tools. But you don't want to hand the agent your raw API keys. **Commands** solve this — they let you connect privileged CLIs to the agent without leaking secrets.

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
//
// `glab` is the official GitLab CLI — scoped to GitLab's API, so the token
// can only reach GitLab. Prefer purpose-built CLIs over general-purpose
// HTTP clients like `curl` for this exact reason.
const glab = defineCommand('glab', {
  env: { GITLAB_TOKEN: process.env.GITLAB_API_TOKEN },
});
const npm = defineCommand('npm');

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ sandbox: 'local', model: 'anthropic/claude-opus-4-7' });
  const session = await agent.session();

  const result = await session.skill('triage', {
    args: {
      issueIid: payload.issueIid,
      projectId: payload.projectId,
    },
    // Grant access to `glab` and `npm` for the life of this skill.
    commands: [glab, npm],
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

The agent can now use `glab` to interact with the GitLab API through the command — but it never has access to the `GITLAB_API_TOKEN` itself. If the agent tries to run `glab` outside of a prompt where it was granted, the command is blocked.

### Roles

Roles are agent personas that shape behavior across prompts. They live alongside your agents under `./.flue/roles/` and ship with the deployed agent:

`.flue/roles/reviewer.md`:

```markdown
---
description: A careful code reviewer focused on correctness and security
---

You are a senior code reviewer. Focus on correctness, security implications,
and adherence to the project's coding standards. Be direct and specific in
your feedback.
```

Use a role by passing its name to `prompt()`:

```typescript
const review = await session.prompt(`Review this MR:\n${diff}`, {
  role: 'reviewer',
  result: v.object({ approved: v.boolean(), comments: v.array(v.string()) }),
});
```

### Sandbox context

The agent reads `AGENTS.md` and skills from its sandbox at runtime. CI agents typically use `sandbox: 'local'`, which mounts the runner's checkout — so any files in your repo are visible automatically.

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

**`AGENTS.md`** at the root of your workspace is the agent's system prompt — it provides global context about the project:

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
      npx flue run triage --target node \
        --id "triage-$ISSUE_IID" \
        --payload "{\"issueIid\": $ISSUE_IID, \"projectId\": \"$CI_PROJECT_ID\"}"
```

Add these as CI/CD variables (**Settings > CI/CD > Variables**, masked):

| Variable            | Description                                       |
| ------------------- | ------------------------------------------------- |
| `ANTHROPIC_API_KEY` | API key for your LLM provider                     |
| `GITLAB_API_TOKEN`  | Project or personal access token with `api` scope |

## Typed results and orchestration

Result schemas aren't just for type safety — they're how you orchestrate multi-step workflows. Because you get typed data back from `prompt()` and `skill()`, you can branch on results within a single agent:

```typescript
import { type FlueContext } from '@flue/sdk/client';
import { defineCommand } from '@flue/sdk/node';
import * as v from 'valibot';

const glab = defineCommand('glab', { env: { GITLAB_TOKEN: process.env.GITLAB_API_TOKEN } });
const npm = defineCommand('npm');

export default async function ({ init, payload }: FlueContext) {
  const agent = await init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });
  const session = await agent.session();

  const diagnosis = await session.skill('triage', {
    args: { issueIid: payload.issueIid },
    commands: [glab],
    result: v.object({
      severity: v.picklist(['low', 'medium', 'high', 'critical']),
      reproducible: v.boolean(),
      summary: v.string(),
    }),
  });

  if (diagnosis.severity === 'critical' && diagnosis.reproducible) {
    // Escalate: attempt an automated fix
    await session.skill('auto-fix', {
      args: { issueIid: payload.issueIid },
      commands: [glab, npm],
      result: v.object({ fix_applied: v.boolean(), branch: v.optional(v.string()) }),
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
npx flue run triage --target node --id test-1 \
  --payload '{"issueIid": 42, "projectId": "123"}'

# Pipe the result to jq
npx flue run triage --target node --id test-2 \
  --payload '{"issueIid": 42}' | jq '.severity'
```

The CLI builds your workspace, starts a temporary server, invokes the agent via SSE, streams progress to stderr, and prints the final result to stdout. The `--id` flag identifies the agent runtime — use a consistent ID to resume the default session, or a unique one for a fresh start.
