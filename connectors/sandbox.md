---
{
  "category": "sandbox",
  "root": true
}
---

# Generic Sandbox Connector

## Goal

You are an AI coding agent being asked to build a Flue **sandbox** connector
for a provider that Flue does not have a built-in recipe for. The deliverable
is one file in the user's project that exports a `SandboxFactory` for the
provider, satisfying Flue's published contract.

There's no fixed procedure for getting there — your provider's shape (typed
SDK, multiple packages, HTTP-only, CLI-driven, something else) will dictate
most of how you implement it. The notes below are the things you can't
reasonably infer from the spec or the worked example.

## Starting point

The user invoked `flue add <url> --category sandbox` with this argument as
their starting point for the provider's documentation:

`{{URL}}`

It's user-provided and was passed through verbatim — it might be the docs
root, an SDK reference, a GitHub repo, a marketing page, or something less
useful. Treat it as a hint, not a verified docs link, and use your judgment
on where to go from there to collect the necessary information to complete your goal.

## References

Read these before writing code.

- **Spec** (the `SandboxFactory` / `SandboxApi` contract):
  `https://raw.githubusercontent.com/withastro/flue/refs/heads/main/docs/sandbox-connector-spec.md`
- **Worked example** (the Daytona connector — one example of a finished
  connector; your provider's shape may be quite different):
  `https://flueframework.com/cli/connectors/daytona.md`

## Flue-specific conventions

These are the things that aren't obvious from the spec or the example.

- **File location.** Treat `.flue/` as a source-folder location, analogous to
  Next.js's `src/`: write to `./.flue/connectors/<name>.ts` if
  `<root>/.flue/` exists, otherwise `./connectors/<name>.ts` at the
  project root. Ask the user if their layout is unusual.
- **Imports.** The published surface is `@flue/runtime`. Don't import
  from `@flue/runtime/internal` or any other internal path.
- **Cancellation.** `SandboxApi.exec()` receives `timeout` (primary) and
  optionally `signal`. Always forward `timeout` to the provider's native
  timeout option when one exists — that's how the LLM bash tool stops a
  command. Forward `signal` only if the provider has a real cancellation
  primitive (`AbortSignal`, process kill, cancel token); otherwise leave
  it alone. The runtime does pre/post `signal.aborted` checks at the
  `SandboxApi` boundary, so you don't need to add them yourself.
- **Credentials.** If the provider needs secrets at runtime, never invent
  values for them. Let the project's conventions (`AGENTS.md`, an existing
  `.env` / `.dev.vars`, a secret manager, CI vars, etc.) decide where they
  belong, and ask the user only if nothing in the project gives a clear
  signal. For local dev, `flue dev --env <file>` and `flue run --env <file>`
  load any `.env`-format file.

## Wrapping up

- Typecheck the project (`npx tsc --noEmit` is safe). Fix anything you broke.
- If the user is mid-task on an agent that this connector is meant to plug
  into, finish that wiring. Otherwise share a small snippet showing how to
  wire it up — typically passing the factory to `init({ sandbox: ... })`.
- Tell the user what commands to run next: any new deps you added, any env
  vars they need to set, and `flue dev`.

## Hard rules

- Never invent API keys, tokens, or secrets.
- Don't modify files outside the connector path you've chosen unless the
  user agreed (e.g. `package.json` to add a dep).
- The published surface is `@flue/runtime`. Don't import from
  `@flue/runtime/internal` or anywhere else.
