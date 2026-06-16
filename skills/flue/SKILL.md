---
name: flue
description: Use when building, debugging, reviewing, or documenting Flue agents, workflows, channels, skills, tools, sandboxes, targets, routing, persistence, observability, or CLI usage; provides agent-focused Flue implementation guidance with links to official docs.
---

# Flue

Use this skill to answer or implement Flue work from a coding-agent perspective. Start with the routing table, open only the references needed for the request, and consult `SOURCES.md` when exact docs, API references, or fresher public documentation are needed.

Never describe direct HTTP/WebSocket agent prompts or `dispatch(...)` inputs as workflow runs. Runs are workflow-only.

## Reference Router

| Topic | Open when... | Reference |
| --- | --- | --- |
| Terminology | You need exact Flue names or must avoid confusing agents, instances, harnesses, sessions, operations, turns, workflows, and runs. | `references/terminology.md` |
| Project layout | You need source-root discovery, generated output, `.flue/` vs `src/`, or file-based entrypoint rules. | `references/project-layout.md` |
| Agent sessions | You are creating addressable agents, initializing harnesses, handling direct prompts, using `dispatch(...)`, or choosing IDs and sessions. | `references/agent-sessions-operations.md` |
| Workflow runs | You are creating, invoking, inspecting, or recovering finite workflow runs. | `references/workflow-runs.md` |
| Skills, tools, subagents | You are deciding between reusable instructions, executable capabilities, sandbox access, MCP tools, or delegated agent profiles. | `references/skill-tool-subagent.md` |
| CLI and build/dev | You need `flue dev`, `build`, `run`, `connect`, `logs`, `add`, `update`, `docs`, config overrides, or local command behavior. | `references/cli-build-dev.md` |
| HTTP routing | You are composing `app.ts`, mounting `flue()`, protecting routes, exposing agents/workflows, or prefixing APIs. | `references/routing-http.md` |
| Node target | You are building or debugging the Node.js server, `local()` sandbox, Node persistence, environment loading, or restart behavior. | `references/target-node.md` |
| Cloudflare target | You are building or debugging Workers, generated Durable Objects, migrations, Workers AI, Cloudflare Sandbox, Shell, or `cloudflare.ts`. | `references/target-cloudflare.md` |
| Channel model | You are adding or reviewing any provider HTTP ingress against Flue's stateless channel ownership model. | `references/channel-model.md` |
| GitHub channel | You are implementing or debugging `@flue/github`, GitHub webhooks, Octokit tools, delivery IDs, or issue/PR conversation keys. | `references/channel-github.md` |
| Slack channel | You are implementing or debugging `@flue/slack`, Events API, interactions, slash commands, Web API tools, or thread conversation keys. | `references/channel-slack.md` |
| Discord channel | You are implementing or debugging `@flue/discord`, interaction responses, REST tools, deadlines, or Discord destination keys. | `references/channel-discord.md` |
| Teams channel | You are implementing or debugging `@flue/teams`, Bot Connector activities, Teams auth, or conversation-bound reply tools. | `references/channel-teams.md` |
| Resend channel | You are implementing or debugging `@flue/resend`, inbound email webhooks, message retrieval, or email instance IDs. | `references/channel-resend.md` |
| Sandbox model | You are choosing between virtual, local, and remote sandboxes or separating workspace persistence from session persistence. | `references/sandbox-model.md` |
| Data persistence | You are configuring `db.ts`, SQLite, Postgres, Cloudflare SQLite, run records, or session durability. | `references/data-persistence.md` |
| Observability and errors | You need `flue logs`, `observe(...)`, event privacy, workflow run inspection, or structured Flue error conventions. | `references/observability-errors.md` |
| Testing conventions | You are adding or reviewing Flue tests and need repository-specific testing posture and naming rules. | `references/testing-conventions.md` |

## Operating Rules

1. Prefer current source and docs over memory when behavior matters.
2. Use `SOURCES.md` for official docs URLs and local source ownership.
3. Keep application-owned authorization, credentials, tenant identity, and provider destinations in trusted code, not model-selected arguments.
4. When delegating with `task`, include a notice that the subagent must not spawn its own subagents.

