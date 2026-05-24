# Sentry observability for Flue

A working example of wiring Flue agents up to [Sentry](https://sentry.io)
for error reporting, AI agent monitoring (gen_ai traces/spans), and
structured logging.

This example is intended to be read top-to-bottom as documentation. The
entire integration lives in [`.flue/app.ts`](.flue/app.ts) — every agent
in `.flue/agents/` is a plain Flue handler that doesn't import Sentry,
doesn't import the bridge, and doesn't know that observability is
happening.

## What you get

After running this example with a Sentry DSN configured:

- **AI Agent Monitoring.** Every agent run becomes a `gen_ai.invoke_agent`
  span. Each LLM turn within the run becomes a `gen_ai.chat` child span
  with model name, token usage (input, output, cached), and cost
  attributes. Each tool call becomes a `gen_ai.execute_tool` child span.
  All spans follow Sentry's [AI Agent Monitoring](https://docs.sentry.io/platforms/javascript/guides/node/ai-agent-monitoring/)
  semantic conventions and appear in the AI monitoring view.
- **Structured Logs.** Every `ctx.log.info/warn/error(...)` call from a
  handler is forwarded to `Sentry.logger` with `flue.run_id` and
  `flue.agent` correlation attributes. Logs appear in the Sentry Logs
  view alongside traces.
- **Error Reporting.** Every run that ends with an unhandled exception
  becomes a Sentry issue. Every `ctx.log.error(...)` call becomes a
  Sentry capture. All tagged with the Flue `runId`, `instanceId`,
  harness name, and session name.
- **Span Streaming.** `streamGenAiSpans: true` sends gen_ai spans as
  standalone envelopes, so large AI spans are not dropped due to payload
  size limits.
- Sentry tags use a stable `flue.*` prefix, so pivoting on
  `flue.run_id` in Sentry's search box finds every capture from a
  single Flue run.

## Files

```
examples/sentry/
├── flue.config.ts            ← build-time config (target, paths)
├── package.json
├── tsconfig.json
├── AGENTS.md                 ← system prompt for any agent that calls init()
├── README.md                 ← you are here
└── .flue/
    ├── app.ts                ← Sentry.init + observe(...) bridge
    └── agents/
        ├── chat.ts           ← LLM call — produces gen_ai spans + logs
        ├── hello.ts          ← success case — no Sentry error traffic
        ├── boom.ts           ← run-fatal throw — captures via run_end
        └── explicit.ts       ← non-fatal log.error — captures while run continues
```

Open `.flue/app.ts` first. The rest of this README explains how to run
and what to look for.

## How the integration works

Flue emits a structured event for every meaningful boundary in a run —
`run_start`, `turn`, `tool_call`, `log`, `run_end`, and others.
Every event carries the Flue correlation tree (`runId`, `harness`,
`session`, `operationId`, `taskId`) so any consumer can reconstruct
what happened.

The `@flue/runtime/app` package exposes a single function for tapping that
stream globally:

```ts
import { observe } from '@flue/runtime/app';

observe((event, ctx) => {
  // event is a fully decorated FlueEvent
  // ctx is the FlueContext of the run that emitted it
});
```

The bridge in `app.ts` is a single `observe(...)` call that maps Flue
events to Sentry:

| Flue event | Sentry output | Details |
|---|---|---|
| `run_start` | `Sentry.startInactiveSpan` | Opens a `gen_ai.invoke_agent` span |
| `run_end` | `span.end()` | Closes the agent span; captures exception if error |
| `turn` | `Sentry.startInactiveSpan` | `gen_ai.chat` span with model, token usage, cost |
| `tool_call` | `Sentry.startInactiveSpan` | `gen_ai.execute_tool` span with tool name |
| `log` (any level) | `Sentry.logger.info/warn/error` | Structured log with correlation attrs |
| `log` (error) | `Sentry.captureException/Message` | Error reporting (unchanged from before) |

## Running it

### 1. Install dependencies

From the repo root:

```bash
pnpm install
```

### 2. Set up Sentry

Get a Sentry DSN from your project's Settings → Client Keys page. Then
either export it or put it in a `.env` file your shell sources:

```bash
export SENTRY_DSN='https://<key>@<org>.ingest.sentry.io/<project>'
export SENTRY_ENVIRONMENT='development'
```

If you skip this step, the integration still works — `Sentry.init` is
called with `enabled: false` and every capture is a no-op.

### 3. Run the dev server

```bash
pnpm exec flue dev --target node
```

The server starts on port `3583`.

### 4. Trigger each scenario

```bash
# LLM call — produces gen_ai spans in Sentry AI monitoring
# Requires ANTHROPIC_API_KEY (or your provider's key)
curl -X POST http://localhost:3583/agents/chat/test1 \
  -H 'content-type: application/json' \
  -d '{ "message": "What is the capital of France?" }'

# Success case — no Sentry error traffic (still produces agent span + logs)
curl -X POST http://localhost:3583/agents/hello/test1 \
  -H 'content-type: application/json' \
  -d '{}'

# Run-fatal throw — one Sentry issue + error span
curl -X POST http://localhost:3583/agents/boom/test1 \
  -H 'content-type: application/json' \
  -d '{}'

# Non-fatal handler-reported errors — two Sentry issues, HTTP 200
curl -X POST http://localhost:3583/agents/explicit/test1 \
  -H 'content-type: application/json' \
  -d '{}'
```

### 5. What to look for in Sentry

- **Traces → AI monitoring:** The `chat` agent produces an
  `invoke_agent` span with nested `chat` spans showing model, token
  counts, and cost.
- **Logs:** All `ctx.log.*` calls appear in the Logs view with
  `flue.run_id` and `flue.agent` attributes for filtering.
- **Issues:** The `boom` and `explicit` agents produce issues tagged
  with `flue.run_id` for cross-referencing.

### 6. Replay a captured run

Take a `flue.run_id` from Sentry and feed it back to the CLI:

```bash
flue logs run_01HX...
```

## Adapting this to your project

1. Add `@sentry/node` (or `@sentry/cloudflare` for the CF target) to
   your dependencies.
2. Copy the `Sentry.init` and `observe(...)` bridge from `app.ts` into
   your own `app.ts`.
3. Decide which event types you care about. The defaults in this example
   (agent spans + turns + tool calls + logs + errors) are a reasonable
   starting point; remove what you don't need.

That's the whole migration. There is nothing to do on a per-agent basis.
