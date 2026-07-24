# Cloudflare example agents

This directory exercises Flue's Cloudflare-specific surfaces. The agents
here are intentionally minimal — each one demonstrates a single capability
end-to-end so it's easy to copy the pattern into a real app. The cf-shell
agents use the project-owned sandbox adapter at `src/sandboxes/cloudflare-shell.ts`, generated conceptually by `flue add sandbox @cloudflare/shell`.

The app is built with Vite: `flue()` from `@flue/vite` plus the official
`@cloudflare/vite-plugin` in `vite.config.ts` (flue first — it prepares the
generated Worker entry and merged wrangler config the Cloudflare plugin
consumes). Agent modules carry the `'use agent'` directive, and `src/app.ts`
mounts each agent's routes explicitly.

## Agents

| Agent                        | Demonstrates                                                                                                                |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `with-cloudflare-binding.ts` | Routing model traffic through the Workers AI binding (no API keys).                                                         |
| `skills-from-r2.ts`          | Hydrating a cf-shell `Workspace` from an R2 bucket and using a discovered skill (via a model-callable `check_spam` action). |
| `skills-from-git.ts`         | Hydrating a cf-shell `Workspace` from a git repo via `createGit`.                                                           |

## Setup

Install deps:

```bash
pnpm install
```

Build the workspace packages once (a fresh checkout has stale `dist/`
directories):

```bash
pnpm run build -F @flue/runtime -F @flue/vite
```

The agents in this example use the Workers AI binding, so no provider API
keys are required. If you switch them to a non-Cloudflare model, put the
matching provider key in `.env` at the project root (see
[the Cloudflare deployment guide](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) for the full story).

## Worker Loader requirement (skills-from-r2, skills-from-git)

Both hydration examples use the project-owned sandbox adapter at `src/sandboxes/cloudflare-shell.ts` and require a `worker_loaders` binding. Worker Loader
is **currently in beta** and your Cloudflare account needs access; the
binding is already declared in `wrangler.jsonc` here.

### Local development caveat

`vite dev` runs the worker in local workerd and can expose a local
`worker_loaders` binding, but Wrangler's local R2 CLI storage may not be
visible to the running dev server's R2 binding. For an end-to-end R2
hydration smoke, use remote resources. You have two options:

- **`wrangler dev --remote`** — runs the worker against Cloudflare's edge
  using your dev bucket. Requires Worker Loader access on your account.
  (Run `pnpm run build` first; `wrangler dev`/`deploy` read the built output
  via the deploy redirect the Cloudflare Vite plugin writes.)
- **deploy to a preview environment** — `pnpm run deploy`, then exercise
  the agent over HTTP afterward.

The cf-shell sandbox adapter exposes a JavaScript `code` tool over its Workspace,
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
# Dev server (local workerd via the Cloudflare Vite plugin)
pnpm run dev

# Production build (deployable Worker output under dist/)
pnpm run build

# Trigger an agent (the mounts live in src/app.ts; port printed by vite dev).
# Prompts are fire-and-forget (202); read the reply from the conversation
# stream with a GET on the same URL.
curl -X POST 'http://localhost:5173/agents/with-cloudflare-binding/test-1' \
  -H 'Content-Type: application/json' -d '{"kind": "user", "body": "Say hello."}'
curl 'http://localhost:5173/agents/with-cloudflare-binding/test-1'

curl -X POST 'http://localhost:5173/agents/skills-from-r2/test-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind": "user", "body": "Check this message for spam: CONGRATS! You won a free iPhone: http://bit.ly/xyz"}'

curl -X POST 'http://localhost:5173/agents/skills-from-git/test-1' \
  -H 'Content-Type: application/json' \
  -d '{"kind": "user", "body": "List every top-level file and directory in the repo, then describe the project."}'
```

`skills-from-r2` and `skills-from-git` write a `/.hydrated` sentinel into
the Durable Object's SQLite on first run; second-run hydration is a no-op
on the sentinel check. Bump the sentinel key in source (or wipe the DO's
storage) to force re-hydration.

> Note: the former `skills-from-*` workflows are now agents. A workflow's
> `run` body became either the message you send (skills-from-git) or a
> model-callable action (`check_spam` in skills-from-r2); conversations are
> the only durable unit.
