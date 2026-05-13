---
{
  "category": "sandbox",
  "website": "https://developers.cloudflare.com/containers",
  "aliases": ["@cloudflare/sandbox", "cloudflare-sandbox", "cf-sandbox"]
}
---

# Add a Flue Connector: Cloudflare Sandbox

You are an AI coding agent helping a user wire up Cloudflare Sandbox in
their Flue project. **This is not a normal connector.** Read this whole
file before you write or install anything — the right action is very
different depending on what target the project is already on.

## The single most important thing to tell the user

`@cloudflare/sandbox` is a Durable Object that runs Cloudflare's container
platform. **It only works inside a Worker** — it cannot be invoked from a
Node.js process. Because of that, Flue treats Cloudflare Sandbox as a
first-class **build target**, not a drop-in connector file.

If the user is already on `--target cloudflare`: there is no connector to
install. Flue's runtime package already provides the wiring; you just declare the
binding in `wrangler.jsonc` and call `getSandbox(env.Sandbox, id)` in the
agent. Skip to ["Path A"](#path-a-already-on---target-cloudflare) below.

If the user is on `--target node` (or hasn't picked yet): adding Cloudflare
Sandbox means **migrating the entire project to deploy on Cloudflare
Workers**. This is a real, multi-step change — Workers, Durable Objects,
`wrangler`, container builds, the lot. Don't pretend it's a single-file
add. Skip to ["Path B"](#path-b-currently-on---target-node) and
**confirm with the user before proceeding**.

For other sandbox providers that are reachable from a Node-target Flue
project (Daytona, E2B, Modal, Vercel, etc.), see `flue add` for those
connectors instead. They install in one file and don't require a deploy
target change.

## Figure out which path you're on

Before writing anything, look at the user's project to determine the
current target:

1. Check `package.json` and any nearby scripts for `flue dev` /
   `flue build` invocations. The presence of `--target cloudflare`
   anywhere is a strong signal they're on Cloudflare already.
2. Check for `wrangler.jsonc` / `wrangler.toml` / `wrangler.json` at the
   project root. Cloudflare-targeted Flue projects always have one.
3. Check `package.json` `dependencies` for `wrangler` and `agents`.

If you find clear evidence of `--target cloudflare`: **Path A**.

If you find no Cloudflare wiring (no `wrangler.jsonc`, no `wrangler` dep,
all scripts use `--target node` or no target flag): **Path B** — and
**confirm with the user that they want to migrate** before doing anything.

If you can't tell or it's ambiguous: ask the user directly. Don't guess.

---

## Path A: Already on `--target cloudflare`

You don't need a connector file. Flue's runtime package already exports the wiring,
and the deploy guide's "Connecting a remote sandbox" section is the
canonical recipe. Steer the user there:

> https://github.com/withastro/flue/blob/main/docs/deploy-cloudflare.md#connecting-a-remote-sandbox

The short version, for your reference:

1. Install `@cloudflare/sandbox` in the user's project:

   ```bash
   npm install @cloudflare/sandbox
   ```

   (Use the user's package manager — `pnpm add`, `yarn add`, etc.)

2. Add a Durable Object binding for the sandbox to the user's
   `wrangler.jsonc` (at the project root). **The `class_name` must end
   with `Sandbox`** — Flue's build step auto-wires any DO whose class name
   ends in `Sandbox` to `@cloudflare/sandbox`'s `Sandbox` class:

   ```jsonc
   {
     "durable_objects": {
       "bindings": [{ "class_name": "Sandbox", "name": "Sandbox" }]
     },
     "migrations": [{ "tag": "v1", "new_sqlite_classes": ["Sandbox"] }],
     "containers": [{ "class_name": "Sandbox", "image": "./Dockerfile" }]
   }
   ```

3. Add a `Dockerfile` at the project root pinned to the matching
   `@cloudflare/sandbox` version:

   ```dockerfile
   FROM docker.io/cloudflare/sandbox:0.9.2
   ```

   (Replace `0.9.2` with whatever version was actually installed in step
   1 — Cloudflare publishes the base image with the same version tag as
   the npm package.)

4. Use it in an agent. The binding name from `wrangler.jsonc` (`Sandbox`
   above) is the key on `env`:

   ```ts
   import type { FlueContext } from '@flue/runtime';
   import { getSandbox } from '@cloudflare/sandbox';

   export const triggers = { webhook: true };

   export default async function ({ init, id, env, payload }: FlueContext) {
     const sandbox = getSandbox(env.Sandbox, id);
     const harness = await init({ sandbox, model: 'anthropic/claude-opus-4-7' });
     const session = await harness.session();

     return await session.prompt(payload.message);
   }
   ```

   Note that `init({ sandbox })` here takes the result of `getSandbox()`
   directly — there is no factory wrapper to import from `@flue/runtime`,
   because Flue's SDK detects and adapts the `@cloudflare/sandbox` shape
   internally on the Cloudflare target.

5. Tell the user to run `flue dev --target cloudflare --env .env` and
   then `flue build --target cloudflare && wrangler deploy
   --secrets-file .env` to deploy. No new env vars are required just for
   the sandbox itself; auth is the user's normal Cloudflare account auth
   via `wrangler login`.

If the user wants multiple sandbox images (e.g. one for Python, one for
Node), they can declare multiple bindings — see the "Multiple sandboxes"
section of the deploy guide.

---

## Path B: Currently on `--target node`

**Stop. Confirm with the user first.**

Adding Cloudflare Sandbox to a project that currently runs on Node is
**not** a one-file change. The sandbox itself is a Cloudflare Containers
Durable Object, which only exists inside a Cloudflare Worker. To use it,
the entire Flue project has to change its deploy target from Node to
Cloudflare Workers, which is a substantial migration that includes:

- Switching `flue dev` / `flue build` invocations to `--target cloudflare`.
- Adding `wrangler` and `agents` (Cloudflare's Agents SDK) as dependencies.
- Adding a `wrangler.jsonc` with Durable Object bindings, container
  bindings, and an R2 binding if they want persistent file storage.
- Adding a `Dockerfile` for the container image.
- Setting up Wrangler authentication (`wrangler login`) and a Cloudflare
  account that has Containers enabled (currently a Workers Paid feature).
- Reviewing any Node-only code in the user's existing agents and
  connectors. Anything that imports from `node:fs`, opens TCP sockets via
  `net`, uses `child_process`, or depends on long-lived background work
  needs rethinking on the Workers runtime.

Before doing any of this, **ask the user**:

1. Are you OK migrating this whole project to deploy on Cloudflare
   Workers? (yes/no)
2. Do you have a Cloudflare account with Containers access? (Containers
   is currently a Workers Paid feature.)

If they say no to either, **stop and recommend an alternative**. Other
sandbox connectors that work from a Node-target Flue project include:

- **Daytona** (`flue add daytona`) — provider-managed sandboxes via
  `@daytona/sdk`.
- **E2B** (`flue add e2b`) — Firecracker microVMs via the `e2b` package.
- **Modal** (`flue add modal`) — sandboxes on Modal's serverless platform.
- **Vercel Sandbox** (`flue add vercel`) — `@vercel/sandbox`.
- **boxd** (`flue add boxd`) — microVMs via `@boxd-sh/sdk`.
- **exe.dev** (`flue add exedev`) — SSH-accessed VMs.

These all keep the project on `--target node` and don't require a
platform migration.

If the user does say yes to migrating, **do not try to do the whole
migration in one shot**. Direct them at the canonical guide instead:

> https://github.com/withastro/flue/blob/main/docs/deploy-cloudflare.md

That document walks through the migration end-to-end:

- Hello-world agent on Cloudflare (`flue dev --target cloudflare`).
- Adding `wrangler.jsonc`, `.env`, and `--target cloudflare` to scripts.
- Optionally adding R2-backed storage (`getVirtualSandbox(env.BUCKET)`)
  if the user only needs a searchable file store and not a full Linux
  container — this is often the right answer and is much cheaper than
  containers.
- Adding the Cloudflare Sandbox container at the end (which is the same
  recipe as Path A above).

Read the guide, then walk the user through it section by section. Don't
short-circuit straight to writing a `wrangler.jsonc` and `Dockerfile`
without first confirming the basics work on `--target cloudflare`.

---

## Hard rules

- **Do not** create a `./.flue/connectors/cloudflare.ts` or
  `./connectors/cloudflare.ts` file. There is no factory function to
  install — Flue's SDK adapts `@cloudflare/sandbox` internally on the
  Cloudflare target.
- **Do not** silently migrate a Node-target project to Cloudflare. Always
  confirm first.
- **Do not** invent a Cloudflare account, API token, or `account_id`. The
  user authenticates with `wrangler login` (or `CLOUDFLARE_API_TOKEN` in
  CI); never guess values.
- **Do not** pin the `cloudflare/sandbox:<version>` Docker tag to a
  version different from the `@cloudflare/sandbox` npm package version
  the user actually installed. They have to match.
- The published Flue surface for Cloudflare-specific helpers is
  `@flue/runtime/cloudflare` (e.g. `getVirtualSandbox`). The
  `@cloudflare/sandbox` package is a separate Cloudflare-published
  dependency the user installs themselves. Don't import from
  `@flue/runtime/internal`.
