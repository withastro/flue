# Cloudflare Target

Use this for Workers, generated Durable Objects, migrations, Cloudflare sandboxes, and Cloudflare extensions.

## Generated Durable Objects

Flue generates a Durable Object class and Wrangler binding for each discovered agent and workflow:

```txt
src/agents/support-chat.ts -> FlueSupportChatAgent, env.FLUE_SUPPORT_CHAT_AGENT
src/workflows/translate.ts -> FlueTranslateWorkflow, env.FLUE_TRANSLATE_WORKFLOW
```

- Agent session state, accepted submissions, and workflow run history are stored in Durable Object SQLite.
- `FlueRegistry` indexes workflow runs across the deployment.
- Cloudflare builds reject source-root `db.ts`.
- Do not hand-author Flue generated `FLUE_*` bindings in `wrangler.jsonc`.

## Wrangler Requirements

`wrangler.jsonc` must include:

- `nodejs_compat` in `compatibility_flags`.
- Durable Object migrations for every generated Flue class.
- `FlueRegistry` in the initial migration.

Use `new_sqlite_classes` for generated Flue classes. Append migrations for added, renamed, or deleted classes. Do not rewrite deployed migration history.

## Durable Execution

- Direct HTTP prompts and `dispatch(...)` inputs enter the same durable per-agent-instance queue.
- The submitting connection observes work but does not own it.
- Disconnect after admission does not necessarily stop backend work.
- Events are durably stored and replayable by offset.
- Recovery requeues only when Flue can prove input was not applied; uncertain model/tool work is recorded as interrupted rather than blindly repeated.

## Workers AI

Use `cloudflare/...` model specifiers on the Cloudflare target without provider API keys:

```ts
model: 'cloudflare/@cf/meta/llama-3.1-8b-instruct'
```

Flue enables AI Gateway by default for `cloudflare/...` models. Re-register the `cloudflare` provider in `app.ts` when customizing gateway behavior.

## Cloudflare Sandbox And Shell

| Need | Use |
| --- | --- |
| Full Linux container with shell commands, git, package installation, native binaries | Cloudflare Sandbox plus `cloudflareSandbox(...)` |
| Durable Workspace with structured code operations but not arbitrary Linux shell | Cloudflare Shell / Codemode generated adapter |
| Prompt-and-response or lightweight workspace work | Default virtual sandbox |

Cloudflare Shell adapters are imported from the generated sandbox adapter file, not from `@flue/runtime/cloudflare`.

## Extension Points

- Export `cloudflare = extend({ base, wrap })` from an agent or workflow module to add module-local Durable Object behavior.
- Do not override Flue-owned `fetch()`, `onRequest()`, `onFiberRecovered()`, or `alarm()`.
- Use `cloudflare.ts` for Worker-level named exports and non-HTTP handlers.
- Do not define a default `fetch` in `cloudflare.ts`; HTTP composition belongs in `app.ts`.

