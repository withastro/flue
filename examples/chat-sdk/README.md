# Chat SDK with Flue

This example uses Chat SDK for bidirectional GitHub issue-comment messaging while Flue owns agent execution.

```txt
signed GitHub issue_comment webhook
  -> Chat SDK GitHub adapter
  -> dispatch(Assistant, ...)
  -> Flue agent tool
  -> bot.thread(threadId).post(...)
  -> fake local GitHub comment API
```

The fixture uses Chat SDK's in-memory state adapter and a scripted model provider so its end-to-end test is local and deterministic. Use persistent Chat SDK state for production integrations.

The assistant agent is _dispatch-only_: its module carries the `'use agent'` directive (which registers it with the app at build time), but `src/app.ts` never mounts it — the webhook handler reaches it through `dispatch()` with no HTTP route.

## Run

```sh
pnpm run dev          # vite dev on port 3585 (pinned in vite.config.ts)
pnpm run test:e2e     # in another terminal
```

Or against the production build:

```sh
pnpm run build
PORT=3585 node dist/server.mjs
pnpm run test:e2e     # in another terminal
```
