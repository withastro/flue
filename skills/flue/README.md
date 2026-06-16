# Maintaining The Flue Skill

This skill is an agent-facing distillation of Flue documentation. Update it with an agent after documentation or runtime behavior changes; do not generate it by copying the docs tree.

## Update Workflow

1. Read the changed docs under `apps/docs/src/content/docs/`.
2. Read nearby docs listed in `apps/docs/src/lib/docs-navigation.ts`.
3. Read implementation source, tests, examples, or blueprints needed to verify behavior.
4. Update only the affected files under `skills/flue/`.
5. Keep runtime references flat under `references/`.
6. List every reference file in `SKILL.md` with a one-line routing reason.
7. Update `SOURCES.md` with local source paths and official docs URLs.
8. Check the contract in `SPEC.md` before finishing.

## Authoring Rules

- Preserve Flue terminology exactly: workflow runs are workflow-only; direct prompts and `dispatch(...)` inputs are agent session operations.
- Prefer dense tables, gotchas, and implementation checklists over copied prose.
- Keep official docs links available in `SOURCES.md` so a consuming agent can fetch deeper or newer detail when available.
- Add provider-specific files with flat names such as `channel-github.md`, `sandbox-cloudflare.md`, or `database-postgres.md`.
- Do not add nested reference directories or broad catch-all files such as `channels.md`.

