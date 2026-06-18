# Cloudflare Sandbox SDK example

This example demonstrates using [Cloudflare Sandbox SDK](https://developers.cloudflare.com/sandbox/) through Flue's Cloudflare sandbox adapter.

Use this example when you want a real Linux/container sandbox for shell commands, package installs, filesystem work, or generated-code execution. For Cloudflare features that do not use Workers Containers, see `examples/cloudflare`.

## What this demonstrates

`src/workflows/sandbox-sdk-smoke.ts` follows the intended Flue layering:

```ts
getSandbox(env.Sandbox, id)
  -> cloudflareSandbox(...)
  -> ctx.init(agent)
  -> harness.fs / harness.shell
```

The workflow constructs the sandbox with `@cloudflare/sandbox`, then uses Flue harness APIs for filesystem and shell operations. Application code stays on Flue's sandbox abstraction after the Cloudflare Sandbox stub is wrapped.

## Requirements

- Cloudflare account access to Workers Containers.
- Docker for local container builds.
- Wrangler authenticated for your account.

Running this example provisions a Cloudflare Container. Accounts without Workers Containers access can still build the example locally, but workflow execution requires the Containers binding.

## Setup

Install workspace dependencies from the repository root:

```bash
pnpm install
```

Build the local Flue packages once if `dist/` is stale:

```bash
pnpm run build -F @flue/runtime -F @flue/cli
```

## Run locally

From this directory:

```bash
pnpm run dev
```

Then invoke the deterministic smoke workflow:

```bash
curl -X POST 'http://localhost:3583/workflows/sandbox-sdk-smoke?wait=result' \
  -H 'Content-Type: application/json' \
  -d '{}'
```

A successful response includes stdout containing:

```text
file: hello from Flue via Cloudflare Sandbox
pwd: /workspace
```

## Build

```bash
pnpm run build
```

The build uses `wrangler.jsonc`, which enables the `Sandbox` container and Durable Object binding for this example package. The container uses the `standard-2` instance type for agent/code-execution workloads; switch it to a smaller type for a lighter development container.
