# Cloudflare example agents

This directory exercises Flue's Cloudflare-specific surfaces. The agents
here are intentionally minimal — each one demonstrates a single capability
end-to-end so it's easy to copy the pattern into a real app. The cf-shell
workflows use the project-owned `src/connectors/cloudflare-shell.ts` implementation generated conceptually by `flue add @cloudflare/shell`.

## Agents

| Agent                          | Demonstrates                                                                       |
| ------------------------------ | ---------------------------------------------------------------------------------- |
| `with-cloudflare-binding.ts`   | Routing model traffic through the Workers AI binding (no API keys).               |
| `skills-from-r2.ts`            | Hydrating a cf-shell `Workspace` from an R2 bucket and using a discovered skill.  |
| `skills-from-git.ts`           | Hydrating a cf-shell `Workspace` from a git repo via `createGit`.                 |

## Setup

Install deps:

```bash
pnpm install
```

Build the runtime + cli once (the local workspace `dist/` directories are
what `flue dev`/`run` consume; a fresh checkout has stale ones — see L1
in the cf-shell adoption plan):

```bash
pnpm run build -F @flue/runtime -F @flue/cli
```

The agents in this example use the Workers AI binding, so no provider API
keys are required. If you switch them to a non-Cloudflare model, put the
matching provider key in `.env` at the project root (see
[the Cloudflare deployment guide](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) for the full story).

## Worker Loader requirement (skills-from-r2, skills-from-git)

Both hydration examples use the project-owned connector at `src/connectors/cloudflare-shell.ts` and require a `worker_loaders` binding. Worker Loader
is **currently in beta** and your Cloudflare account needs access; the
binding is already declared in `wrangler.jsonc` here.

### Local development caveat

`wrangler dev` local mode can expose a local `worker_loaders` binding, but
Wrangler's local R2 CLI storage may not be visible to the running dev
server's R2 binding. For an end-to-end R2 hydration smoke, use remote
resources. You have two options:

- **`wrangler dev --remote`** — runs the worker against Cloudflare's edge
  using your dev bucket. Requires Worker Loader access on your account.
- **`wrangler deploy` to a preview environment** — deploy first, exercise
  the agent over HTTP afterward.

The cf-shell connector exposes a JavaScript `code` tool over its Workspace,
not bash or a live R2 mount. If your account doesn't have Worker Loader
access, or you need Linux tools or bucket paths mounted directly, use
`@cloudflare/sandbox` (Containers + `mountBucket`) instead.

### Seeding R2 (skills-from-r2 only)

Before running `skills-from-r2`, put a SKILL.md into your dev R2 bucket
so the hydration step has something to copy:

```bash
# from this directory; requires wrangler installed + authenticated
./seed-r2.sh
```

The script writes `.agents/skills/spam-filter/SKILL.md` into
`flue-example-knowledge-base-dev`. Pass `BUCKET=prod` to seed the prod
bucket instead.

If you want to use different bucket names, edit `wrangler.jsonc` and the
`BUCKET_NAME` table in `seed-r2.sh` in lockstep.

## Running

```bash
# Build + serve (one of these, depending on Loader access for the agent you want)
pnpm exec flue dev --target cloudflare
pnpm exec wrangler dev --remote                  # if needed for cf-shell agents

# Trigger an agent
curl -X POST http://localhost:3583/agents/with-cloudflare-binding/test-1 \
  -H 'Content-Type: application/json' -d '{}'

curl -X POST http://localhost:3583/workflows/skills-from-r2?wait=result \
  -H 'Content-Type: application/json' -d '{}'

curl -X POST http://localhost:3583/workflows/skills-from-git?wait=result \
  -H 'Content-Type: application/json' -d '{}'
```

`skills-from-r2` and `skills-from-git` write a `/.hydrated` sentinel into
the Durable Object's SQLite on first run; second-run hydration is a no-op
on the sentinel check. Bump the sentinel key in source (or wipe the DO's
storage) to force re-hydration.

## Migrating from `getVirtualSandbox`

If you're coming from `getVirtualSandbox(env.BUCKET)`, the replacement is
`getShellSandbox({ workspace, loader })` plus an explicit
`hydrateFromBucket(workspace, env.BUCKET)` step before the sandbox is
created. `skills-from-r2.ts` is the canonical example of that flow. R2 is
only a hydration source here; it is not mounted as the Workspace filesystem.
