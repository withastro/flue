# Cloudflare Shell Sandbox

Flue's Cloudflare shell sandbox is built on [`@cloudflare/shell`](https://www.npmjs.com/package/@cloudflare/shell): a durable, SQLite-indexed `Workspace` plus a codemode `code` tool that runs JavaScript in an isolated Worker through a `worker_loaders` binding.

The common R2 hydration flow only imports Flue helpers. Install `@cloudflare/shell` directly when you want to construct custom Workspaces or use git helpers like `WorkspaceFileSystem` and `createGit`.

This replaces the old `getVirtualSandbox(env.BUCKET)` API. That API described R2 as if it were mounted directly as the agent filesystem. That was not accurate: `Workspace` stores directory/file metadata in Durable Object SQLite and only uses R2 as blob spillover for large files written through the Workspace API. Raw R2 keys uploaded with `wrangler r2 object put` are not visible until you explicitly hydrate them into the Workspace.

## Basic Pattern

```ts
import type { FlueContext } from '@flue/runtime';
import {
  getDefaultWorkspace,
  getShellSandbox,
  hydrateFromBucket,
} from '@flue/runtime/cloudflare';

export const triggers = { webhook: true };

export default async function ({ init, env, payload }: FlueContext) {
  const workspace = getDefaultWorkspace();

  if (!(await workspace.exists('/.hydrated'))) {
    await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);
    await workspace.writeFile('/.hydrated', new Date().toISOString());
  }

  const harness = await init({
    sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
    model: 'anthropic/claude-sonnet-4-6',
  });
  const session = await harness.session();

  return session.prompt(`Answer this using the hydrated workspace: ${payload.message}`);
}
```

Add the Worker Loader and R2 bindings to `wrangler.jsonc`:

```jsonc
{
  "compatibility_flags": ["nodejs_compat"],
  "worker_loaders": [{ "binding": "LOADER" }],
  "r2_buckets": [{ "binding": "KNOWLEDGE_BASE", "bucket_name": "my-knowledge-base" }]
}
```

Worker Loader is currently in beta. If local `wrangler dev` does not simulate `worker_loaders`, use `wrangler dev --remote` or deploy to a preview environment.

## What The Agent Sees

The cf-shell sandbox does not expose `bash`, `grep`, `glob`, `read`, `write`, or `edit`. It exposes:

- `code` — JavaScript execution in an isolated Worker.
- `task` — Flue's framework-owned child-agent tool.

Inside the `code` tool, the model can call `state.*` methods provided by `@cloudflare/shell`, for example:

```js
async () => {
  const files = await state.readdir('/');
  const article = await state.readFile('/articles/reset-password.md');
  return { files, excerpt: article.slice(0, 500) };
}
```

## Using `session.fs` from your own code

Programmatic file access still works through `session.fs` and `harness.fs`, backed by the same Workspace as the agent's `code` tool:

```ts
await harness.fs.writeFile('/notes.md', 'staged before the session starts');
const session = await harness.session();
const notes = await session.fs.readFile('/notes.md');
```

Use these filesystem APIs for setup, post-processing, or any other host-side file access. Paths are Workspace paths such as `/foo.md`; there is no `/workspace` mount prefix.

`session.shell()` and `harness.shell()` throw because cf-shell has no shell. If you need Linux commands, use `@cloudflare/sandbox` Containers instead.

## Default Workspace

`getDefaultWorkspace()` constructs `new Workspace({ sql: getCloudflareContext().storage.sql })` for the current agent Durable Object.

Call it inside an agent invocation, not at module top level. Calling it twice in the same agent instance returns two handles to the same default-namespace backing store. If you need isolated workspaces inside one Durable Object, install `@cloudflare/shell` and construct them yourself with explicit namespaces:

```ts
import { Workspace } from '@cloudflare/shell';

const workspace = new Workspace({
  sql: ctx.storage.sql,
  namespace: 'subagent-a',
  r2: env.WORKSPACE_FILES,
});
```

## R2 Hydration

`hydrateFromBucket(workspace, bucket, options?)` eagerly copies matching R2 objects into the Workspace:

```ts
await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE, { prefix: 'articles/' });
```

With `prefix: 'articles/'`, a bucket key `articles/reset-password.md` becomes `/reset-password.md` in the Workspace.

Hydration is intentionally not idempotent. Use a sentinel key you own:

```ts
const sentinel = '/.hydrated-kb-v1';
if (!(await workspace.exists(sentinel))) {
  await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);
  await workspace.writeFile(sentinel, new Date().toISOString());
}
```

If hydration fails partway through, earlier writes remain. Re-run after fixing the error, or wipe the Durable Object storage if you need a clean rebuild.

Large files written into a Workspace may be spilled back to R2 under Workspace's own key scheme. That can duplicate large source objects once; it is correct, but not a raw bucket mount.

## Git Hydration

For git, install `@cloudflare/shell` and use its primitives directly:

```ts
import { WorkspaceFileSystem } from '@cloudflare/shell';
import { createGit } from '@cloudflare/shell/git';
import { getDefaultWorkspace } from '@flue/runtime/cloudflare';

const workspace = getDefaultWorkspace();
if (!(await workspace.exists('/.hydrated'))) {
  const git = createGit(new WorkspaceFileSystem(workspace));
  await git.clone({
    url: 'https://github.com/FredKSchott/vinext-starter',
    dir: '/repo',
    depth: 1,
    singleBranch: true,
  });
  await workspace.writeFile('/.hydrated', new Date().toISOString());
}
```

Flue does not wrap git hydration because `createGit(...).clone(...)` is already the natural API.

## Migrating From getVirtualSandbox

Old:

```ts
import { getVirtualSandbox } from '@flue/runtime/cloudflare';

const sandbox = await getVirtualSandbox(env.KNOWLEDGE_BASE);
const harness = await init({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
```

New:

```ts
import {
  getDefaultWorkspace,
  getShellSandbox,
  hydrateFromBucket,
} from '@flue/runtime/cloudflare';

const workspace = getDefaultWorkspace();
if (!(await workspace.exists('/.hydrated'))) {
  await hydrateFromBucket(workspace, env.KNOWLEDGE_BASE);
  await workspace.writeFile('/.hydrated', new Date().toISOString());
}

const harness = await init({
  sandbox: getShellSandbox({ workspace, loader: env.LOADER }),
  model: 'anthropic/claude-sonnet-4-6',
});
```

If you used `getVirtualSandbox()` with no bucket, remove the call entirely and omit `sandbox` from `init()`. Flue's default in-memory sandbox is already that behavior.

## When You Need Bucket-Keys-As-Paths

If your requirement is literally "R2 bucket keys appear as filesystem paths" or you need shell commands like `grep`, `find`, or language toolchains, use [`@cloudflare/sandbox`](https://developers.cloudflare.com/containers/) with [`mountBucket`](https://developers.cloudflare.com/sandbox/guides/mount-buckets/) instead. That gives you a real Linux container and direct bucket mount semantics. cf-shell is the lightweight Workspace + codemode path, not a Linux filesystem mount.
