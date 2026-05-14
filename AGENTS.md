# Flue

Agent framework where agents are directories compiled into deployable server artifacts.

## Terminology

```
Agent (definition)              — `agents/<name>.ts`; named by its file
└─ AgentInstance                — URL `<id>`; exposed to handlers as `ctx.id`
   └─ Run                       — one HTTP invocation; exposed as `ctx.runId`
      └─ Harness                — one `init({ name })` call; defaults to `"default"`
         └─ Session             — one `harness.session(name?)`; defaults to `"default"`
            └─ Operation        — one `session.prompt` / `skill` / `task` / `shell` call
               └─ Turn          — one LLM round-trip inside pi-agent-core
```

Use `harness` as the variable name for the return value of `init()`. Agents have names; agent instances have ids; harnesses and sessions have names; runs and operations have generated ids.

## Project Structure

- `packages/runtime/` — Runtime library (`@flue/runtime`). Session management, agent harness, tools, sandbox plumbing. What a built Flue app depends on.
- `packages/cli/` — CLI + build/dev tooling (`@flue/cli`). Owns `flue dev`/`run`/`build`/`init`/`add`/`logs`, the esbuild plugins, agent-file parsing, env-file loading, and the `flue.config.ts` resolver. Eventually rolls up into the `flue` npm package; for now `defineConfig` is imported via `@flue/cli/config`.
- `examples/hello-world/` — Test root with example agents covering the runtime's surfaces.
- `examples/cloudflare/` — Test root for Cloudflare-specific features (Workers AI binding, etc.).

## Building

Runtime must be built before CLI or example agents:

```
pnpm run build          # in packages/runtime/
pnpm run build          # in packages/cli/
```

## Running Agents

Three commands:

- `flue dev` — long-running watch-mode dev server. Edits trigger rebuilds + reloads.
- `flue run` — one-shot, production-style: build, invoke an agent once, exit. Used in CI / scripted invocations.
- `flue build` — produce a `dist/` deployable artifact (no run).

`--root` points at the project root. Defaults to the current working directory if omitted. By default, the build is written to `<root>/dist/`; use `--output <path>` to redirect the build elsewhere.

Source files (agents, roles) live in one of two places, analogous to Next.js's `src/` folder:

- `<root>/.flue/agents/`, `<root>/.flue/roles/` if a `.flue/` directory exists.
- Otherwise `<root>/agents/`, `<root>/roles/` directly.

The two layouts never mix — if `.flue/` is present, the bare layout is ignored entirely.

### `flue.config.ts`

A `flue.config.{ts,mts,mjs,js,cjs,cts}` file at the project root may set `target`, `root`, or `output`. Discovered automatically (or via `--config <path>`). CLI flags always override values from the config file.

```ts
// flue.config.ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

Relative `root` / `output` values resolve against the directory containing the config file (Vite-style: the config file's dir IS the project root). The config is loaded via Node's native TS support (Node ≥ 22.18).

### `flue dev`

Default port: `3583` ("FLUE" on a phone keypad). Override with `--port`.

```
cd examples/hello-world
node ../../packages/cli/bin/flue.mjs dev --target node
# or:
node ../../packages/cli/bin/flue.mjs dev --target cloudflare
```

For `--target cloudflare`, the project must have `wrangler` available (it's a peer dependency of `@flue/cli`).

### `flue run`

```
node packages/cli/bin/flue.mjs run <agent-name> --target node --id <id> [--payload '<json>'] [--root <path>] [--output <path>]
```

Examples (run from the `examples/hello-world/` directory so the `./.flue/` source layout is picked up):

```
cd examples/hello-world
node ../../packages/cli/bin/flue.mjs run hello --target node --id test-1
node ../../packages/cli/bin/flue.mjs run with-role --target node --id test-2 --payload '{"name": "Fred"}'
```

This builds the project, starts a temporary server, invokes the agent via SSE, streams output to stderr, prints the final result to stdout, and shuts down.

**Requires `ANTHROPIC_API_KEY` in the environment.** For testing, use `claude-haiku-4-5` (cheapest model).

## Type Checking

```
pnpm run check:types    # in packages/runtime/
```

## Models

`provider/model-id` strings; providers come from pi-ai's registry. API keys via env (`ANTHROPIC_API_KEY`, etc.) or provider configuration in `app.ts` via `configureProvider()` / `registerProvider()`.

```ts
init({ model: 'anthropic/claude-sonnet-4-6' })
init({ model: 'openai/gpt-4.1-mini' })
```

`cloudflare/...` routes through `env.AI.run()` on the Cloudflare target — no API keys, just `"ai": { "binding": "AI" }` in `wrangler.jsonc`. Errors clearly on `--target node`.

```ts
init({ model: 'cloudflare/@cf/moonshotai/kimi-k2.6' })
```

## Architecture

### Agent = Deployed Workspace

A repo is built and deployed as an agent. `flue build` compiles the root (skills, roles, agents, context) into a self-contained server artifact. On every push to main, the agent is rebuilt and redeployed.
