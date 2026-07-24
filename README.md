# Flue — The Agent Harness Framework

Not another SDK. Build autonomous agents with Flue's programmable TypeScript harness.

```ts
// agents/triage.ts
'use agent';
import { useModel, useSandbox, useSkill, useTool } from '@flue/runtime';
import { local } from '@flue/runtime/node';
import triage from '../skills/triage/SKILL.md';
import verify from '../skills/verify/SKILL.md';
import { openIssue, searchCode } from '../tools/github.ts';

// The agent IS the function. Compose the complete harness it needs to do
// real work, complete with virtual, local, or remote container sandbox.
export function Triage() {
  useModel('anthropic/claude-sonnet-4-6');
  useSandbox(local());
  useSkill(triage);
  useSkill(verify);
  useTool(openIssue);
  useTool(searchCode);

  // Give agents the context and autonomy to solve complex tasks:
  return `
Triage a bug report end-to-end: reproduce the bug,
diagnose the root cause, verify whether the behavior is
intentional, and attempt a fix.

...`;
}
```

## The framework for building the next generation of agents.

The first agents were built with raw LLM API calls. This worked for simple chatbots and scripted tasks, but not much else.

Agents like Claude Code and Codex broke the mold. These were _real agents._ Autonomous. You give them a task — not a pre-defined series of steps — and trust them to complete it using the context and tools that you provide.

**Flue unlocks this new architecture for agents.** Its built-in TypeScript harness gives any model the context and environment it needs for truly autonomous work: sessions, tools, skills, instructions, filesystem access, and a secure sandbox to run in. Run your agents locally via CLI or deploy them to your hosted runtime of choice.

## Features

Build agents that can safely take action, maintain continuity, and connect to the systems where work already happens.

- **[Agents](https://flueframework.com/docs/guide/building-agents/)** — Build agents that can keep context across conversations and events as they autonomously work toward a goal.
- **[Sandboxes](https://flueframework.com/docs/guide/sandboxes/)** — Give agents a secure environment where they can use tools, modify files, and autonomously complete real work.
- **[Durability](https://flueframework.com/docs/guide/durability/)** — Learn how agents preserve progress through failures and restarts with durable recovery for accepted work.
- **[Subagents](https://flueframework.com/docs/guide/subagents/)** — Define specialized roles for different tasks, then let your agent delegate work to the right expert.
- **[Tools](https://flueframework.com/docs/guide/tools/)** — Give agents typed actions for calling APIs, querying data, and making controlled changes through your application.
- **[Skills](https://flueframework.com/docs/guide/skills/)** — Package reusable expertise and workflows that agents can load whenever a task needs specialized guidance.
- **[MCP Servers](https://flueframework.com/docs/guide/tools/#connect-mcp-tools)** — Connect agents to authenticated tools and services through the open Model Context Protocol ecosystem.
- **[Observability](https://flueframework.com/docs/guide/observability/)** — Monitor your agents and export telemetry with [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/), [Braintrust](https://flueframework.com/docs/ecosystem/tooling/braintrust/), [Sentry](https://flueframework.com/docs/ecosystem/tooling/sentry/), or your own observer.
- **[Channels](https://flueframework.com/docs/guide/channels/)** — Receive verified events from Slack, Teams, Discord, GitHub, and more.

## Deploy Anywhere

- **[Node.js](https://flueframework.com/docs/ecosystem/deploy/node/)**
- **[Cloudflare Workers](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)**
- **[GitHub Actions](https://flueframework.com/docs/ecosystem/deploy/github-actions/)**
- **[GitLab CI/CD](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)**
- **[Daytona](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)**
- **[Render](https://flueframework.com/docs/ecosystem/deploy/render/)**

## Packages

| Package                                         | Description                                                    |
| ----------------------------------------------- | -------------------------------------------------------------- |
| [`@flue/runtime`](packages/runtime)             | Runtime: harness, sessions, tools, sandbox                     |
| [`@flue/vite`](packages/vite)                   | Vite plugin: `vite dev` / `vite build` for Node and Cloudflare |
| [`@flue/cli`](packages/cli)                     | CLI (`flue` binary): local runs, blueprints, offline docs      |
| [`@flue/sdk`](packages/sdk)                     | Client SDK for consuming deployed agent conversations          |
| [`@flue/opentelemetry`](packages/opentelemetry) | OpenTelemetry tracing adapter                                  |
| [`@flue/postgres`](packages/postgres)           | Postgres persistence adapter                                   |
