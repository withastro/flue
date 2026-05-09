# Flue

Agent framework where agents are directories compiled into deployable server artifacts.

## Project Structure

- `packages/sdk/` — Core SDK (`@flue/sdk`). Build system, session management, agent harness, tools.
- `packages/cli/` — CLI (`@flue/cli`). `flue run` command.
- `examples/hello-world/` — Test workspace with example agents covering the SDK's surfaces.
- `examples/cloudflare/` — Test workspace for Cloudflare-specific features (Workers AI binding, etc.).

## Building

SDK must be built before CLI or example agents:

```
pnpm run build          # in packages/sdk/
pnpm run build          # in packages/cli/
```

## Running Agents

Three commands:

- `flue dev` — long-running watch-mode dev server. Edits trigger rebuilds + reloads.
- `flue run` — one-shot, production-style: build, invoke an agent once, exit. Used in CI / scripted invocations.
- `flue build` — produce a `dist/` deployable artifact (no run).

`--workspace` points at the workspace root — the project directory. Defaults to the current working directory if omitted. By default, the build is written to `<workspace>/dist/`; use `--output <path>` to redirect the build elsewhere.

Source files (agents, roles) live in one of two places, analogous to Next.js's `src/` folder:

- `<workspace>/.flue/agents/`, `<workspace>/.flue/roles/` if a `.flue/` directory exists.
- Otherwise `<workspace>/agents/`, `<workspace>/roles/` directly.

The two layouts never mix — if `.flue/` is present, the bare layout is ignored entirely.

### `flue.config.ts`

A `flue.config.{ts,mts,mjs,js,cjs,cts}` file at the workspace root may set `target`, `workspace`, or `output`. Discovered automatically (or via `--config <path>`). CLI flags always override values from the config file.

```ts
// flue.config.ts
import { defineConfig } from '@flue/sdk/config';

export default defineConfig({
  target: 'node',
});
```

Relative `workspace` / `output` values resolve against the directory containing the config file (Vite-style: the config file's dir IS the project root). The config is loaded via Node's native TS support (Node ≥ 23.6) with an esbuild fallback for older runtimes.

### `flue dev`

Default port: `3583` ("FLUE" on a phone keypad). Override with `--port`.

```
cd examples/hello-world
node ../../packages/cli/bin/flue.mjs dev --target node
# or:
node ../../packages/cli/bin/flue.mjs dev --target cloudflare
```

For `--target cloudflare`, the project must have `wrangler` available (it's a peer dependency of `@flue/sdk`).

### `flue run`

```
node packages/cli/bin/flue.mjs run <agent-name> --target node --id <id> [--payload '<json>'] [--workspace <path>] [--output <path>]
```

Examples (run from the `examples/hello-world/` directory so the `./.flue/` source layout is picked up):

```
cd examples/hello-world
node ../../packages/cli/bin/flue.mjs run hello --target node --id test-1
node ../../packages/cli/bin/flue.mjs run with-role --target node --id test-2 --payload '{"name": "Fred"}'
```

This builds the workspace, starts a temporary server, invokes the agent via SSE, streams output to stderr, prints the final result to stdout, and shuts down.

**Requires `ANTHROPIC_API_KEY` in the environment.** For testing, use `claude-haiku-4-5` (cheapest model).

## Type Checking

```
pnpm run check:types    # in packages/sdk/
```

## Models

`provider/model-id` strings; providers come from pi-ai's registry. API keys via env (`ANTHROPIC_API_KEY`, etc.) or `init({ providers: { ... } })`.

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

A repo is built and deployed as an agent. `flue build` compiles the workspace (skills, roles, agents, context) into a self-contained server artifact. On every push to main, the agent is rebuilt and redeployed.
