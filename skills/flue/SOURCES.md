# Flue Skill Sources

This file maps skill references to canonical Flue docs, local source, and official public URLs. Use these sources to verify behavior before updating runtime guidance.

## Source Inventory

| Reference | Local docs and source | Official docs |
| --- | --- | --- |
| `references/terminology.md` | `AGENTS.md`; `apps/docs/src/content/docs/concepts/agents.mdx`; `apps/docs/src/content/docs/concepts/durable-execution.md` | https://flueframework.com/docs/concepts/agents/ |
| `references/project-layout.md` | `apps/docs/src/content/docs/guide/project-layout.md`; `apps/docs/src/content/docs/reference/configuration.md`; `packages/cli/src/lib/config.ts`; `packages/cli/src/lib/config-paths.ts` | https://flueframework.com/docs/guide/project-layout/ |
| `references/agent-sessions-operations.md` | `apps/docs/src/content/docs/guide/building-agents.md`; `apps/docs/src/content/docs/api/agent-api.md`; `packages/runtime/src/context.ts`; `packages/runtime/test/session-operations.test.ts` | https://flueframework.com/docs/guide/building-agents/ |
| `references/workflow-runs.md` | `apps/docs/src/content/docs/guide/workflows.md`; `apps/docs/src/content/docs/sdk/runs.md`; `packages/runtime/test/routing.test.ts` | https://flueframework.com/docs/guide/workflows/ |
| `references/skill-tool-subagent.md` | `apps/docs/src/content/docs/guide/skills.md`; `apps/docs/src/content/docs/guide/tools.md`; `apps/docs/src/content/docs/guide/subagents.md`; `packages/runtime/src/skill-frontmatter.ts`; `packages/runtime/test/session-skills.test.ts` | https://flueframework.com/docs/guide/skills/ |
| `references/cli-build-dev.md` | `packages/cli/bin/flue.ts`; `apps/docs/src/content/docs/cli/*.md`; `apps/docs/src/content/docs/reference/configuration.md` | https://flueframework.com/docs/cli/overview/ |
| `references/routing-http.md` | `apps/docs/src/content/docs/guide/routing.md`; `apps/docs/src/content/docs/api/routing-api.md`; `packages/runtime/test/routing.test.ts` | https://flueframework.com/docs/guide/routing/ |
| `references/target-node.md` | `apps/docs/src/content/docs/guide/targets/node.md`; `apps/docs/src/content/docs/ecosystem/deploy/node.md`; `packages/runtime/src/node/*` | https://flueframework.com/docs/guide/targets/node/ |
| `references/target-cloudflare.md` | `apps/docs/src/content/docs/guide/targets/cloudflare.md`; `apps/docs/src/content/docs/ecosystem/deploy/cloudflare.md`; `packages/runtime/src/cloudflare/*`; `packages/cli/src/lib/build-plugin-cloudflare.ts` | https://flueframework.com/docs/guide/targets/cloudflare/ |
| `references/channel-model.md` | `apps/docs/src/content/docs/guide/channels.md`; `apps/docs/src/content/docs/api/*-channel.md`; `blueprints/channel.md` | https://flueframework.com/docs/guide/channels/ |
| `references/channel-github.md` | `apps/docs/src/content/docs/ecosystem/channels/github.md`; `apps/docs/src/content/docs/api/github-channel.md`; `packages/github/` | https://flueframework.com/docs/ecosystem/channels/github/ |
| `references/channel-slack.md` | `apps/docs/src/content/docs/ecosystem/channels/slack.md`; `apps/docs/src/content/docs/api/slack-channel.md`; `packages/slack/` | https://flueframework.com/docs/ecosystem/channels/slack/ |
| `references/channel-discord.md` | `apps/docs/src/content/docs/ecosystem/channels/discord.md`; `apps/docs/src/content/docs/api/discord-channel.md`; `packages/discord/` | https://flueframework.com/docs/ecosystem/channels/discord/ |
| `references/channel-teams.md` | `apps/docs/src/content/docs/ecosystem/channels/teams.md`; `apps/docs/src/content/docs/api/teams-channel.md`; `packages/teams/` | https://flueframework.com/docs/ecosystem/channels/teams/ |
| `references/channel-resend.md` | `apps/docs/src/content/docs/ecosystem/channels/resend.md`; `apps/docs/src/content/docs/api/resend-channel.md`; `packages/resend/` | https://flueframework.com/docs/ecosystem/channels/resend/ |
| `references/sandbox-model.md` | `apps/docs/src/content/docs/guide/sandboxes.md`; `apps/docs/src/content/docs/api/sandbox-api.md`; `apps/docs/src/content/docs/ecosystem/sandboxes/*.md` | https://flueframework.com/docs/guide/sandboxes/ |
| `references/data-persistence.md` | `apps/docs/src/content/docs/guide/database.md`; `apps/docs/src/content/docs/api/data-persistence-api.md`; `packages/postgres/`; `packages/runtime/src/adapter*` | https://flueframework.com/docs/guide/database/ |
| `references/observability-errors.md` | `apps/docs/src/content/docs/guide/observability.md`; `apps/docs/src/content/docs/api/events-reference.md`; `apps/docs/src/content/docs/api/errors-reference.md`; `packages/runtime/src/errors.ts` | https://flueframework.com/docs/guide/observability/ |
| `references/testing-conventions.md` | `AGENTS.md`; active tests under `packages/*/test/`; package scripts in `package.json` | https://flueframework.com/docs/ |

## Adopted Decisions

- Adopted: Use a top-level `skills/flue/` source artifact for the installable skill.
- Adopted: Keep the skill authored by agents from docs/source, not generated from the full docs tree.
- Adopted: Keep runtime references flat and specifically named.
- Adopted: Include official docs URLs in this source map for deeper verification.
- Rejected: Copying all docs pages into `references/`.
- Rejected: Nested provider directories such as `references/channels/github.md`.
- Rejected: Broad runtime buckets such as `channels.md`.

## Coverage Notes

- Initial provider-specific channel coverage includes GitHub, Slack, Discord, Teams, and Resend because their ecosystem guides contain concrete protocol, credential, deadline, and tool-binding behavior.
- Other first-party channels should get `channel-[name].md` only when the reference can contain meaningful provider-specific guidance. Until then, use `channel-model.md` plus the official docs URL.
- Sandbox provider-specific files should follow the same rule, such as `sandbox-cloudflare.md` or `sandbox-e2b.md`, when the shared sandbox model is not enough.

## Stopping Rationale

The first version covers the core Flue docs surfaces and representative provider-specific channel references without mirroring the full docs tree. Additional provider files should be added as docs work creates concrete agent-facing guidance.

