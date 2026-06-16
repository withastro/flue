# Skills, Tools, And Subagents

Use this when deciding what capability to add to an agent.

## Decision Table

| Need | Use |
| --- | --- |
| Reusable instructions, checklist, or process | Agent Skill |
| Application code action or data lookup | Tool |
| Filesystem or command workspace | Sandbox |
| Focused delegated reasoning role | Subagent profile |
| Remote tool server | MCP tools through `connectMcpServer(...)` |

Skills guide work; they do not add executable capabilities. Tools execute application code. Sandboxes provide file and command access.

## Skills In Flue

- Imported skills use `import review from '../skills/review/SKILL.md' with { type: 'skill' }`.
- Passing imported references in `skills` makes them available to the agent.
- Workspace-discovered skills are loaded from `<cwd>/.agents/skills/<name>/`.
- Imported and workspace skills cannot share the same declared name.
- Skill frontmatter `name` must match the directory name, be lower-case hyphenated, and be at most 64 characters.
- Supporting files beside `SKILL.md` are packaged for imported skills; do not store secrets there.

Invoke a skill manually with `session.skill('name', { args, result })` when application logic needs it.

## Tools

- Define tools with `defineTool(...)`.
- Use action-oriented names like `lookup_order_status`.
- Validate model-selected arguments with Valibot or JSON Schema.
- Bind credentials, tenants, repository IDs, ticket IDs, and destinations in trusted code.
- The model should choose content or narrow values, not authority boundaries.
- Per-call tools can be supplied through `session.prompt`, `session.skill`, or `session.task` options.

## Subagents

- A subagent is a named `defineAgentProfile(...)` declared on a parent agent.
- It runs in a separate child session.
- It is not addressable at `/agents/<name>/<id>`.
- The profile `description` should tell the parent when to delegate.
- `instructions`, `tools`, `skills`, and `subagents` are profile-owned; omitted means none.
- `model`, `thinkingLevel`, and `compaction` inherit as defaults.
- `durability` on a subagent profile is rejected.
- A `task()` call without `agent` reuses the parent's full configuration in a fresh context.

When asking a subagent to review or implement work, include a notice that it must not spawn its own subagents.

