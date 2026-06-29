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

You need two processes: a Flue dev server (the backend) and this SPA.

### 1. Start a Flue example dev server

CORS is required because the SPA runs on a different origin. `flue dev` enables a
dev-only CORS layer automatically.

The richest target is the `react-chat` example's `helper` agent, a real Anthropic model
with a tool, reasoning, and a subagent. It needs `ANTHROPIC_API_KEY`:

```sh
# from the repo root, with ANTHROPIC_API_KEY in ./.env
cd examples/react-chat
node ../../packages/cli/bin/flue.mjs dev --target node --port 3583 --env ../../.env
```

`flue dev` loads `<exampleDir>/.env` by default, so pass `--env` to use the repo-root key.

For a **credential-free** target, the same example exposes a faux echo `assistant`
agent, and `hello-world` exposes `session-test`.

### 2. Start the SPA

```sh
pnpm --filter flue-demo dev
# or, from this directory:
pnpm dev
```

Open the printed URL (e.g. `http://localhost:5174`).

### 3. Connect

Open **Settings** (the gear button, bottom-left) and set the **Agent URL** — the whole
target is one URL, and everything after `/agents/` is the agent name:

| Target                          | Agent URL                                  | Needs key |
| ------------------------------- | ------------------------------------------ | --------- |
| hello-world (session-test)      | `http://localhost:3583/agents/session-test`| yes       |
| react-chat (assistant, faux)    | `http://localhost:3583/api/agents/assistant`| no       |
| react-chat (helper, live model) | `http://localhost:3583/api/agents/helper`  | yes       |

The same dialog also selects the **live transport** (default live or explicit long-poll)
and holds an optional **bearer token** for agents behind a `route` auth check.

## How it connects

- `src/lib/flue-client.ts` parses the agent URL into the SDK `baseUrl` and agent name
  (`<baseUrl>/agents/<name>/<id>`) and creates a `FlueClient` per connection.
- `src/components/chat/chat-view.tsx` uses `useFlueAgent({ name, id, live })`, with the
  transport coming from settings. The conversation `id` is the agent instance id, which is
  also the local conversation id. The same view calls `client.agents.abort(name, id)` to
  stop in-flight or queued work for that agent instance.
- `src/components/chat/message-parts.tsx` renders each `FlueConversationPart`
  (`text` | `reasoning` | `file` | `dynamic-tool`); `tool-display.tsx` maps tool calls to
  their one-line summaries.

## Notes / known gaps

- The production bundle is large because Markdown + syntax highlighting are bundled
  eagerly; code-split them if you adapt this for production.

See `plans/2026-06-26-demo-chat-app.md` for the full build log and framework feedback.
