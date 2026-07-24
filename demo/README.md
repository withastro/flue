# Flue Demo Chat

A standalone **Vite + React** single-page chat client that connects to **any running
Flue example dev server**. It's a real-world manual-testing harness, a proof-of-concept
for new runtime features, and a reference application showing how to build a chat UI on
top of `@flue/sdk` and `@flue/react`.

It is intentionally styled with a plain shadcn/ui look so it reads as a skinnable
starting point rather than a finished product.

## What it demonstrates

- Streaming responses with GitHub-flavored Markdown (tables, lists, highlighted code).
- Cancelling an in-progress agent response from the composer stop button.
- A transient **"Thinking…"** indicator while the agent works; optional **reasoning**
  display (toggle in settings) that streams the thoughts live.
- **Tool calls** as one-line summaries (built-ins get custom renderers, e.g.
  `read <path>`); click to expand the input/output payloads.
- **Subagent delegation** (the framework `task` tool) surfaced as "Delegated to `<agent>`".
- **Data parts** (`useMessageData`): the react-chat `helper` agent streams a live weather
  card (`data-weather`) that shows a loading state mid-tool-run and updates in place; any
  other `data-<name>` part renders as a generic named-JSON disclosure.
- **Agent-authored message metadata** (`useMessageMetadata`): the reply footer's model
  label and relative "time ago" come from `model`/`timestamp` metadata the agent attaches —
  the runtime stamps nothing, so both simply disappear for agents that attach none.
- Multi-step replies grouped into one block (a tool-calling turn + an answer turn share a
  single avatar and footer).
- Multi-turn conversations with server-side history.
- A conversation sidebar (metadata persisted to `localStorage`; transcripts live on the
  server via durable streams, so a reload or reconnect restores the full conversation).
- **Talk to any agent by URL** — change the agent URL in settings to point anywhere; a
  selectable live transport and optional bearer token.
- Automatic light/dark theme via `prefers-color-scheme`.

## Stack

Vite, React 19, TypeScript, Tailwind v4, shadcn/ui, TanStack Router, `streamdown`
(streaming Markdown), and the workspace packages `@flue/sdk` and `@flue/react`.

## Running it

You need two processes: a Flue server (the backend) and this SPA. The SPA can talk to
**any** of the three local server shapes — `vite dev` on the Node target, `vite dev` on
the Cloudflare target (workerd), and `vite preview` over a built Node artifact. All
three are covered because the `flue()` Vite plugin applies a permissive local CORS
policy (reflected origin + the durable-stream coordination headers) to dev servers on
both targets and to `vite preview`. A production `node dist/server.mjs` has **no** CORS
layer — that's an application concern — so point the demo at dev/preview servers.

### 1. Start a Flue backend

**Fastest credential-free target** — the `react-chat` example's faux echo `assistant`:

```sh
# from the repo root
cd examples/react-chat
pnpm exec vite dev --port 3583
```

`--port 3583` matches this SPA's default agent URL, so the demo connects with zero
configuration.

**Richest target** — the same example's `helper` agent: a real Anthropic model with a
tool, reasoning, and a subagent. Put `ANTHROPIC_API_KEY` in the example's `.env` (or
export it) — `vite dev` loads the project's `.env` files automatically, shell-exported
values winning:

```sh
cd examples/react-chat
echo 'ANTHROPIC_API_KEY="sk-..."' > .env
pnpm exec vite dev --port 3583
```

**Cloudflare target (workerd)** — any Cloudflare-target Flue app's `vite dev` works
identically; the same CORS defaults apply through the workerd path. The repo's
`examples/cloudflare` agents use real Workers AI bindings (Cloudflare credentials), so
for a credential-free workerd check, scaffold a scratch project with a faux provider —
the pattern in `packages/vite/test/helpers/cloudflare-fixture.ts` (an offline
OpenAI-completions endpoint on the host loopback that workerd's outbound fetch can
reach) is copy-pasteable.

**Built artifact** — build the Node target and serve it with `vite preview`; preview
imports the built `dist/app.mjs`, so this exercises exactly what production would run:

```sh
cd examples/react-chat
pnpm exec vite build
pnpm exec vite preview --port 3583
```

### 2. Start the SPA

```sh
pnpm --filter flue-demo dev
# or, from this directory:
pnpm dev
```

Open the printed URL (e.g. `http://localhost:5174`).

### 3. Connect

Open **Settings** (the agent-target button in the sidebar footer — it shows the current
agent name + URL) and set the **Agent URL** — the whole target is one URL: wherever the
app's `app.ts` mounts the agent's routes (everything after `/agents/` is used as the
display name):

| Target                          | Agent URL                                    | Needs key |
| ------------------------------- | -------------------------------------------- | --------- |
| react-chat (assistant, faux)    | `http://localhost:3583/api/agents/assistant` | no        |
| react-chat (helper, live model) | `http://localhost:3583/api/agents/helper`    | yes       |
| hello-world (session-test)      | `http://localhost:3583/agents/session-test`  | yes       |

The same dialog also selects the **live transport** (default live or explicit long-poll)
and holds an optional **bearer token** for agents behind a `route` auth check.

Switching the Agent URL while viewing a conversation from a different server leaves the
old transcript unreachable (its history 404s on the new server) — start a new chat after
switching.

## How it connects

- `src/lib/flue-client.ts` builds one conversation URL per chat — the configured agent
  mount URL plus the caller-chosen conversation id — and creates a
  `createFlueClient({ url })` client per connection.
- `src/components/chat/chat-view.tsx` uses `useFlueAgent({ client, live })`, with the
  transport coming from settings. The conversation id appended to the URL is the agent
  instance id, which is also the local conversation id. The same view calls
  `client.abort()` to stop in-flight or queued work for that conversation.
- `src/components/chat/message-parts.tsx` renders each `FlueConversationPart`
  (`text` | `reasoning` | `file` | `dynamic-tool`); `tool-display.tsx` maps tool calls to
  their one-line summaries.

## Notes / known gaps

- The production bundle is large because Markdown + syntax highlighting are bundled
  eagerly; code-split them if you adapt this for production.

See `plans/2026-06-26-demo-chat-app.md` for the full build log and framework feedback.
