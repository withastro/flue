---
{
  "kind": "sandbox",
  "version": 1,
  "root": true
}
---

# Generic Sandbox Adapter

## Goal

You are an AI coding agent being asked to build a Flue **sandbox** adapter
for a provider that Flue does not have a built-in blueprint for. The deliverable
is one file in the user's project that exports a `SandboxFactory` for the
provider, satisfying Flue's published contract.

There's no fixed procedure for getting there — your provider's shape (typed
SDK, multiple packages, HTTP-only, CLI-driven, something else) will dictate
most of how you implement it. The notes below are the things you can't
reasonably infer from the spec or the worked example.

## Starting point

The user invoked `flue add sandbox <url>` or `flue update sandbox <url>` with
this argument as their starting point for the provider's documentation:

`{{URL}}`

It's user-provided and was passed through verbatim — it might be the docs
root, an SDK reference, a GitHub repo, a marketing page, or something less
useful. Treat it as a hint, not a verified docs link, and use your judgment
on where to go from there to collect the necessary information to complete your goal.

For an update, inspect the user's current adapter before editing. Compare it
with this refreshed complete guide, the provider's current primary sources,
and the current Flue contract. Infer which changes are relevant, apply only
those changes, preserve project-specific customizations, and update the primary
file's `flue-blueprint` marker only after the adapter conforms. A URL blueprint
has no provider-specific historical diff; do not assume the CLI compared or
modified the implementation.

## References

Read these before writing code.

- **Spec** (the `SandboxFactory` / `SandboxApi` contract):
  `https://flueframework.com/docs/api/sandbox-api/index.md`
- **Worked example** (the Daytona adapter — one example of a finished
  adapter; your provider's shape may be quite different):
  `https://flueframework.com/cli/blueprints/daytona.md`

## Flue-specific conventions

These are the things that aren't obvious from the spec or the example.

- **File location.** Select the first existing source directory in this order:
  `<root>/.flue/`, `<root>/src/`, then `<root>/`. Write the adapter to
  `<source-dir>/sandboxes/<name>.ts`. Its first generated line must be
  `// flue-blueprint: sandbox/<provider>@1`, replacing `<provider>` with the
  selected provider slug. Ask the user if their layout is unusual.
- **Imports.** The published surface is `@flue/runtime`. Don't import
  from `@flue/runtime/internal` or any other internal path.
- **Cancellation.** `SandboxApi.exec()` receives `timeoutMs` in milliseconds
  (primary) and optionally `signal`. Always forward `timeoutMs` to the provider's
  native timeout option when one exists, converting units and rounding up when
  the provider has coarser granularity — that's how the LLM bash tool stops a
  command. Forward `signal` only if the provider has a real cancellation
  primitive (`AbortSignal`, process kill, cancel token); otherwise leave it
  alone. The runtime does pre/post `signal.aborted` checks at the `SandboxApi`
  boundary, so you don't need to add them yourself.
- **Credentials.** If the provider needs secrets at runtime, never invent
  values for them. Let the project's conventions (`AGENTS.md`, an existing
  `.env` / `.dev.vars`, a secret manager, CI vars, etc.) decide where they
  belong, and ask the user only if nothing in the project gives a clear
  signal. For local dev, `flue dev --env <file>` and `flue run --env <file>`
  load any `.env`-format file.

## Wrapping up

- Typecheck the project (`npx tsc --noEmit` is safe). Fix anything you broke.
- If the user is mid-task on an agent that this adapter is meant to plug
  into, finish that wiring. Otherwise share a small snippet showing how to
  wire it up — pass the factory in the `AgentRuntimeConfig` supplied directly to `ctx.init(...)` from a workflow, or return it from `createAgent(...)` in a default-exported addressable agent module.
- Tell the user what commands to run next: any new deps you added, any env
  vars they need to set, and `flue dev`.

## Hard rules

- Never invent API keys, tokens, or secrets.
- Don't modify files outside the adapter path you've chosen unless the
  user agreed (e.g. `package.json` to add a dep).
- The published surface is `@flue/runtime`. Don't import from
  `@flue/runtime/internal` or anywhere else.

## Upgrade Guide

### Version 1 — 2026-06-14

Initial version.
