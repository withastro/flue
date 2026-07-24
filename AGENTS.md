# Flue

Framework where projects containing agents are built into deployable server artifacts by the `flue()` Vite plugin.

## About This Repository

This repository is Flue's publish destination, not its development home. Development happens in a private repository, and every release lands here as a single versioned commit whose diff is everything that changed since the previous release. There is no development history to bisect between releases.

The test suite and internal planning documents are not part of the published tree, so `pnpm test` finds no test files here. Every snapshot is verified before publish: `pnpm install --frozen-lockfile`, `pnpm build`, and `pnpm check:types` must pass on exactly the tree in this repository.

## Contributing

See `CONTRIBUTING.md` for the full picture. In short:

- **Bug reports** → https://github.com/withastro/flue/issues
- **Feature requests** → https://github.com/withastro/flue/discussions
- **Pull requests** are not accepted; they are automatically closed and converted into one of the two contribution types above.

## Terminology

```
Agent                         — a capitalized, exported plain function; Flue Hooks in its body attach
                                tools, instructions, and state, and its returned string is its
                                instruction; the function name (or its `agentName` string-literal
                                static) is the agent's durable identity
Agent module                  — a source file whose first statement is the `'use agent'` directive;
                                every capitalized exported function in it is an agent
└─ AgentInstance              — URL `<id>`; the agent's durable identity, independent of authoring
   └─ Harness                 — runtime-initialized agent environment; defaults to name `"default"`
      └─ Session              — one `harness.session(name?)`; defaults to `"default"`
         └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
            └─ Turn          — one LLM round-trip inside pi-agent-core
```

There are no workflows or runs: conversations are the only durable unit, and a bounded code job is a tool with `harness: true`. Direct HTTP agent prompts and dispatched agent inputs operate within persistent sessions; `dispatch(...)` is identified by its `submissionId`.

Routing is explicit: `app.ts` is the application's route map, mounting each HTTP-reachable agent (`app.route('/agents/<name>', createAgentRouter(AgentFn))`) and channel (`app.route('/channels/<x>', channel.route())`). Registration comes from the `'use agent'` scan, not from mounting.

A blueprint is a Markdown implementation guide returned by `flue add`; its kind is `sandbox`, `database`, `channel`, or `tooling`.

## Project Structure

- `packages/runtime/` — Runtime library (`@flue/runtime`): sessions, agent harnesses, tools, sandbox plumbing, and the `/config` loader for `flue.config.ts`.
- `packages/vite/` — The `flue()` Vite plugin (`@flue/vite`): `'use agent'` scan/transform, generated bootstraps, Node dev/build, and the Cloudflare target adapter.
- `packages/cli/` — CLI (`@flue/cli`): `flue run` transport-free local execution, `init`, blueprint `add`/`update`, and offline `docs`.
- `examples/` — Integration examples for channels, databases, sandboxes, and deployment targets.
- `demo/` — Standalone Vite+React chat SPA that connects to any running Flue example server.
- `apps/docs/` — The documentation site; its content is the source of truth for user-facing docs.

## Development

```
pnpm install
pnpm build          # turbo build across the workspace
pnpm check:types    # typecheck (excludes apps-www)
```
