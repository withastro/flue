# Flue

Agent framework where agents are directories compiled into deployable server artifacts.

## Project Structure

- `packages/sdk/` — Core SDK (`@flue/sdk`). Build system, session management, agent harness, tools.
- `packages/cli/` — CLI (`@flue/cli`). `flue run` command.
- `examples/hello-world/` — Test workspace with 7 example agents.

## Building

SDK must be built before CLI or example agents:

```
pnpm run build          # in packages/sdk/
pnpm run build          # in packages/cli/
```

## Running Agents

Use the CLI to build and run an agent in one step:

```
node packages/cli/dist/flue.js run <agent-name> [--workspace <path>] [--output <path>] [--payload '<json>']
```

`--workspace` points at the directory containing `agents/` and `roles/`. If omitted, the CLI looks for `./.flue/` first, else falls back to `./`. `--output` controls where `dist/` is written; defaults to the current directory.

Examples (run from the `examples/hello-world/` directory so the `./.flue/` waterfall picks it up):

```
cd examples/hello-world
node ../../packages/cli/dist/flue.js run hello
node ../../packages/cli/dist/flue.js run with-role --payload '{"name": "Fred"}'
node ../../packages/cli/dist/flue.js run with-skill --payload '{"name": "World"}'
```

Or pass both flags explicitly:

```
node packages/cli/dist/flue.js run hello --workspace examples/hello-world/.flue --output examples/hello-world
```

This builds the workspace, starts a temporary server, invokes the agent via SSE, streams output to stderr, prints the final result to stdout, and shuts down.

**Requires `ANTHROPIC_API_KEY` in the environment.** For testing, use `claude-haiku-4-5` (cheapest model, set as default in build config).

## Type Checking

```
pnpm run check:types    # in packages/sdk/
```

## Architecture

### Agent = Deployed Workspace

A repo is built and deployed as an agent. `flue build` compiles the workspace (skills, roles, agents, context) into a self-contained server artifact. On every push to main, the agent is rebuilt and redeployed.
