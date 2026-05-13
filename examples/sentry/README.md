# Sentry error reporting for Flue

A working example of wiring Flue agents up to [Sentry](https://sentry.io)
for error reporting.

This example is intended to be read top-to-bottom as documentation. The
entire integration lives in [`.flue/app.ts`](.flue/app.ts) — every agent
in `.flue/agents/` is a plain Flue handler that doesn't import Sentry,
doesn't import the bridge, and doesn't know that error reporting is
happening.

## What you get

After running this example with a Sentry DSN configured:

- Every run that ends with an unhandled exception (the handler throws
  or rejects) becomes a Sentry issue tagged with the Flue `runId`,
  `instanceId`, harness name, and session name.
- Every `ctx.log.error(...)` call from a handler becomes a Sentry
  capture — an exception if the log carries an `error` attribute, a
  message otherwise.
- Sentry tags use a stable `flue.*` prefix, so pivoting on
  `flue.run_id` in Sentry's search box finds every capture from a
  single Flue run.
- A failing run in Sentry can be replayed in full by feeding the tags
  back into the Flue CLI:

  ```
  flue logs <flue.agent> <flue.instance_id> <flue.run_id>
  ```

## What this example does NOT do

Deliberate scope cuts, listed up front so you can decide whether this
example fits your needs:

- **No spans, no traces.** Flue's event stream carries `durationMs`,
  `usage`, `operationKind`, and other span-shaped fields, but this
  integration does not emit Sentry spans. Adding spans is a layered
  follow-up rather than a redesign — the same `observe(...)` hook can
  call `Sentry.startInactiveSpan` for wide lifecycle events when
  you're ready.
- **No log forwarding for `info` / `warn`.** Only `log.error` reaches
  Sentry. If you want `log.info` as Sentry breadcrumbs, add a one-line
  `Sentry.addBreadcrumb(...)` call to the bridge in `app.ts`.
- **No tool-error capture.** Tool failures are usually recoverable
  (the model handles them and keeps going), so capturing them would
  drown out real incidents. The bridge in `app.ts` documents how to
  opt in.
- **No AI metrics.** Token counts, costs, and model identities live on
  Flue's `turn` and `operation` events, but this example does not
  forward them to Sentry as measurements or attributes.

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
        ├── hello.ts          ← success case — no Sentry traffic
        ├── boom.ts           ← run-fatal throw — captures via run_end
        └── explicit.ts       ← non-fatal log.error — captures while run continues
```

Open `.flue/app.ts` first. Every line is commented to explain why it's
there. The rest of this README explains how to run, what to look for,
and how the pieces fit together.

## How the integration works

Flue emits a structured event for every meaningful boundary in a run —
`run_start`, `operation`, `tool_call`, `log`, `run_end`, and others.
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

`observe` is called once at module scope. The subscriber receives every
event from every run handled by the current isolate.

The bridge in `app.ts` is a single `observe(...)` call that filters for
two event shapes:

| Flue event | Sentry call | Severity |
|---|---|---|
| `run_end` with `isError: true` | `captureException` (reconstructed Error) | `error` |
| `log` with `level: 'error'` and `attributes.error` | `captureException` (reconstructed Error) | `error` |
| `log` with `level: 'error'` and no `error` attribute | `captureMessage` | `error` |

Every capture is enclosed in `Sentry.withScope(...)` so the Flue tags
do not leak into unrelated events captured by Sentry's auto-instrumentation
elsewhere in the process.

## Isolate scoping (Node vs. Cloudflare)

`observe` is described as "global," but the precise meaning differs by
target:

- **Node target.** One V8 isolate per server process. `observe` is
  truly global — register once in `app.ts`, captures fire for every
  run the server handles.

- **Cloudflare target.** Each agent runs in its own [Durable
  Object](https://developers.cloudflare.com/durable-objects/), which
  is a separate V8 isolate from the outer Worker and from every other
  DO. `app.ts` is evaluated once per isolate. That means
  `Sentry.init` and `observe(...)` execute independently inside each
  DO. Every isolate has its own Sentry client and captures its own
  events. This is the only thing that *can* work on Cloudflare — there
  is no shared module state across isolates — and it is the right
  shape: no cross-isolate RPC for every event, each agent
  independently reports its own errors.

You do not have to think about this when writing handlers. Put
`Sentry.init` and `observe(...)` at the top of `app.ts` and the rest is
automatic.

## Running it

### 1. Install dependencies

From the repo root:

```bash
pnpm install
```

This example declares `@flue/runtime` as a workspace dependency and
`@sentry/node` as a regular npm dependency. The workspace install picks
up both.

### 2. Set up Sentry

Get a Sentry DSN from your project's Settings → Client Keys page. Then
either export it or put it in a `.env` file your shell sources:

```bash
export SENTRY_DSN='https://<key>@<org>.ingest.sentry.io/<project>'
export SENTRY_ENVIRONMENT='development'
```

If you skip this step, the integration still works — `Sentry.init` is
called with `enabled: false` and every capture is a no-op. The example
runs identically, you just won't see any traffic in Sentry's UI.

### 3. Run the dev server

```bash
pnpm exec flue dev --target node
```

The server starts on port `3583`.

### 4. Trigger each scenario

```bash
# Success case — no Sentry traffic
curl -X POST http://localhost:3583/agents/hello/test1 \
  -H 'content-type: application/json' \
  -d '{}'

# Run-fatal throw — one Sentry issue
curl -X POST http://localhost:3583/agents/boom/test1 \
  -H 'content-type: application/json' \
  -d '{}'

# Non-fatal handler-reported errors — two Sentry issues, HTTP 200
curl -X POST http://localhost:3583/agents/explicit/test1 \
  -H 'content-type: application/json' \
  -d '{}'
```

Each response includes a `_meta.runId` field. That's the same id you'll
see as the `flue.run_id` tag in Sentry.

### 5. Replay a captured run

Take a `flue.run_id` from Sentry and feed it back to the CLI:

```bash
flue logs boom test1 run_01HX...
```

The CLI streams the full event log of that run — including the
`run_end` event that triggered the Sentry capture.

## Adapting this to your project

To use this pattern in your own Flue project:

1. Add `@sentry/node` (or `@sentry/cloudflare` for the CF target) to
   your dependencies.
2. Copy `installSentryEventBridge` from `app.ts` into your own
   `app.ts`, alongside your own `Sentry.init` call.
3. Decide which event types you care about. The defaults in this
   example (run-fatal + `log.error`) are a reasonable starting point;
   the bridge code documents what each branch does and how to enable
   the others.

That's the whole migration. There is nothing to do on a per-agent
basis.

## Going further

When you outgrow error-only reporting, the same `observe(...)` hook can
carry more:

- **Breadcrumbs.** Forward `log.info` / `log.warn` to
  `Sentry.addBreadcrumb(...)` so each captured exception has the
  in-run log trail attached.
- **Spans.** The wide `operation`, `tool_call`, `turn`, and `run_end`
  events all carry `durationMs`. Synthesize Sentry spans from
  `(timestamp - durationMs, timestamp)` to build a flame graph for
  every run. The `gen_ai.*` OpenTelemetry semantic conventions are a
  good attribute schema to target — see Sentry's GenAI docs.
- **Metrics.** `turn.usage` carries input/output/cache tokens and cost.
  Forward as Sentry measurements or to a separate metrics sink.

None of those require changes to your agents. They all live inside the
same `observe(...)` callback you already have.
