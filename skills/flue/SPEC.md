# Flue Skill Specification

## Intent

The Flue skill gives coding agents a compact, implementation-focused map of Flue's documented behavior. It converts the public docs and repository conventions into routed guidance that helps agents build, debug, review, and document Flue projects without rereading the whole docs site.

## Scope

In scope:

- Flue terminology, source layout, agents, workflows, sessions, operations, runs, routing, CLI commands, targets, channels, sandboxes, persistence, observability, and repository testing conventions.
- Provider-specific channel guidance when the docs provide concrete setup, protocol, runtime, or failure behavior.
- Links to official docs and local source paths for deeper verification.

Out of scope:

- Copying the full documentation corpus into the skill.
- Replacing official API references or provider documentation.
- Adding executable update scripts for the authored skill content.
- Capturing secrets, private customer data, or non-public deployment URLs.

## Users And Trigger Context

- Primary users: coding agents implementing, reviewing, debugging, or documenting Flue work.
- Common user requests: create a Flue agent, write a workflow, add a channel, choose a sandbox, configure a target, inspect runs, fix persistence, or update docs.
- Should not trigger for: unrelated agent frameworks, generic TypeScript questions, or provider SDK work that does not touch Flue.

## Runtime Contract

- `SKILL.md` must provide a complete flat reference inventory and route every reference with a one-line reason.
- Runtime references must be direct children of `references/`.
- Broad shared files must answer a concrete decision, such as `channel-model.md`; provider-specific files use flat names such as `channel-github.md`.
- The skill must preserve the workflow-only meaning of runs.
- The skill must not invent behavior beyond docs, source, tests, examples, or blueprints.

## Source And Evidence Model

Authoritative sources:

- Public docs under `apps/docs/src/content/docs/`.
- Docs navigation under `apps/docs/src/lib/docs-navigation.ts`.
- Runtime, CLI, SDK, and provider package source under `packages/`.
- Active tests under `<package>/test/`.
- Repository instructions in `AGENTS.md`.

Useful improvement sources:

- Changelog entries and release notes.
- Blueprints under `blueprints/`.
- Examples under `examples/`.
- Review feedback that identifies a concrete correctness or durability risk.

Data that must not be stored:

- secrets, tokens, private keys, webhook raw bodies, provider response URLs, customer data, private URLs, or private identifiers not needed for reproduction.

## Reference Architecture

- `SKILL.md` contains the runtime router and universal guardrails.
- `references/` contains flat, runtime-loadable lookup files.
- `SOURCES.md` contains provenance, official docs URLs, local source ownership, decisions, and gaps.
- `README.md` contains the portable agentic maintenance process.
- No `scripts/` or generated runtime files are part of this skill.

## Validation

Lightweight validation:

- Confirm `SKILL.md` frontmatter name is `flue` and matches the directory.
- Confirm every `references/*.md` file is listed in `SKILL.md`.
- Confirm every reference has source ownership in `SOURCES.md`.
- Confirm no nested files exist under `references/`.

Deeper validation:

- Ask the skill to answer representative Flue implementation questions and verify against official docs/source.
- Check provider-specific files against their package docs and API references after channel docs change.

Acceptance gates:

- No copied full docs pages.
- No vague plural category buckets such as `channels.md` or nested `references/channels/github.md`.
- Official docs links remain available in `SOURCES.md`.

## Known Limitations

- This skill is curated and may omit details that are already better served by the official docs or API reference.
- Provider-specific references are added only when they contain useful behavior beyond the shared model.
- The skill does not guarantee the public docs URL is reachable from every runtime environment.

## Maintenance Notes

- Update `SKILL.md` when adding, removing, or renaming a reference.
- Update `SOURCES.md` whenever source ownership, official docs URLs, or known gaps change.
- Update only affected references when docs change; do not mirror the docs tree.

