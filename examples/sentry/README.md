# Sentry observability for Flue

A working example of wiring Flue agents up to [Sentry](https://sentry.io)
for errors, logs, and AI traces.

This example is intended to be read top-to-bottom as documentation. The
entire integration lives in [`src/sentry.ts`](src/sentry.ts), imported
once from `app.ts` — every agent in `src/agents/` is a plain Flue agent
that doesn't import Sentry, doesn't import the bridge, and doesn't know
that observability is happening.

## What you get

After running this example with a Sentry DSN configured:

- **Issues** for terminal failures only: every failed agent operation and
  every durable submission that settles as `failed` becomes one Sentry
  issue carrying the original error and its throw-site stack.
- **Logs** for everything: every `log.info` / `log.warn` / `log.error`
  call arrives in Sentry Logs at its own level, tagged with the Flue
  correlation ids. Recovered errors an agent logs and moves past are
  logs, not issues.
- **Traces** when `SENTRY_TRACES_SAMPLE_RATE > 0`: each conversation
  turn shows up as an `invoke_agent` span with `chat` (model turn) and
  `execute_tool` children, following the OpenTelemetry GenAI semantic
  conventions, with token usage on the model spans. A conversation's
  spans, logs, and issues share one trace.
- Stable `flue.*` tags across all three — pivoting on `flue.instance.id`
  in Sentry's search box finds every capture from a single agent
  instance, and `flue.submission.id` pins down one submission.

Model and tool **content** (prompts, completions, tool arguments and
results) stays out of traces by default. `SENTRY_AI_RECORD_INPUTS` and
`SENTRY_AI_RECORD_OUTPUTS` opt in per direction, and everything that
leaves the process passes a redaction pass first.

## Files

```
examples/sentry/
├── vite.config.ts            ← the flue() Vite plugin; vite dev/build own the app
├── package.json
├── tsconfig.json
├── .env.example              ← every knob the integration reads
├── AGENTS.md                 ← system prompt for any agent that calls init()
├── README.md                 ← you are here
└── src/
    ├── sentry.ts             ← the entire integration: init + traces + bridge
    ├── app.ts                ← imports ./sentry.ts, mounts the agents
    └── agents/
        ├── assistant.ts      ← tool-using agent — the full-trace demo
        ├── hello.ts          ← success case — a log and a trace, no issue
        ├── boom.ts           ← terminal failure — one Sentry issue
        └── explicit.ts       ← recovered errors — error logs, no issue
```

Open `src/sentry.ts` first. Every section is commented to explain why
it's there.

## How the integration works

Flue emits a structured event for every meaningful boundary in an
agent's work — `operation_start`, `operation`, `turn_request`, `turn`,
`tool`, `log`, `submission_settled`, and others — each carrying its
correlation tree (`instanceId`, `submissionId`, `agentName`,
`conversationId`, `operationId`, `taskId`). See
[Observability](https://flueframework.com/docs/guide/observability/) for
the vendor-neutral event contract.

The integration registers two things through `instrument(...)`:

1. **Flue's OpenTelemetry instrumentation** (when tracing is enabled).
   `Sentry.init` owns the global tracer provider, so the spans Flue
   emits land in Sentry directly. Sentry's own AI provider integrations
   are suppressed so model calls aren't double-counted.
2. **A keyed event bridge** that maps events to the Sentry SDK:

   | Flue event                                    | Sentry call                                                                           |
   | --------------------------------------------- | ------------------------------------------------------------------------------------- |
   | `operation` with `isError: true`              | `captureException` (issue)                                                            |
   | `submission_settled` with `outcome: 'failed'` | `captureException` — only if the failure wasn't already captured from its `operation` |
   | `log` at any level                            | `Sentry.logger.<level>(...)`                                                          |

Both registrations are keyed, which makes `vite dev` reloads safe: the
module re-evaluates on every edit, the newest install wins, and the
previous one is disposed — no stacked subscribers, no duplicate
captures.

Every issue capture is enclosed in `Sentry.withScope(...)` so the Flue
tags do not leak into unrelated events captured elsewhere in the
process.

### Shutdown flush

`sentry.ts` installs SIGINT/SIGTERM listeners that call
`Sentry.flush(2000)` without ever calling `process.exit()` — Flue's
generated server owns shutdown. This is best-effort, not a delivery
guarantee: the server exits as soon as its own lifecycle stop resolves,
so a flush still in flight can be cut short. Traces and issues are sent
during the run; only very-recently-buffered logs are at risk.

## Isolate scoping (Node vs. Cloudflare)

- **Node target.** One V8 isolate per server process. Register once (the
  `app.ts` import) and the bridge sees every agent the server handles.
- **Cloudflare target.** Each agent runs in its own Durable Object — its
  own V8 isolate — and the module graph evaluates once per isolate, so
  each DO reports its own activity independently. The Cloudflare setup
  differs in one more way: `Sentry.init` is replaced by wrapping each
  generated DO class via a module-local `cloudflare` extension. This
  example targets Node; run `flue add tooling sentry` in a Cloudflare
  project to get the full Cloudflare wiring.

## Running it

### 1. Install dependencies

From the repo root:

```bash
pnpm install
```

### 2. Configure

Copy `.env.example` to `.env` and fill in `SENTRY_DSN` (from your Sentry
project's Settings → Client Keys page) and `ANTHROPIC_API_KEY`. The
example's `.env` defaults keep `SENTRY_TRACES_SAMPLE_RATE=1.0` so every
conversation produces a trace.

If you skip the DSN, the integration still works — `Sentry.init` runs
with `enabled: false` and every capture is a no-op. The example runs
identically, you just won't see traffic in Sentry's UI.

### 3. Run the dev server

```bash
pnpm exec vite dev
```

Vite prints the local URL it is serving (`http://localhost:5173` by
default — substitute yours below).

### 4. Trigger each scenario

Agent prompts are fire-and-forget: `POST` returns a `202` admission and
the conversation stream (a `GET` of the same URL) carries the outcome.
The trailing path segment is the caller-chosen conversation id.

```bash
# Full trace — invoke_agent → chat → execute_tool, plus an info log
curl -X POST http://localhost:5173/agents/assistant/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Where is demo order A123?"}'

# Success case — a log and a trace, no issue
curl -X POST http://localhost:5173/agents/hello/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Run the hello action."}'

# Terminal failure — one Sentry issue (the agent initializer throws)
curl -X POST http://localhost:5173/agents/boom/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Anything — this agent always fails."}'

# Recovered errors — error-level logs, agent completes, no issue
curl -X POST http://localhost:5173/agents/explicit/demo-1 \
  -H 'content-type: application/json' \
  -d '{"kind":"user","body":"Run the explicit action."}'

# Watch a conversation's stream
curl http://localhost:5173/agents/assistant/demo-1
```

### 5. Look in Sentry

- **Traces** (Explore → Traces): the assistant conversation is one trace
  — `invoke_agent Assistant` with a `chat claude-haiku-4-5` child (token
  usage in its attributes) and an `execute_tool lookup_order` child.
  With the record flags off, spans carry timing, usage, and ids but no
  message or tool content.
- **Logs** (Explore → Logs): the tool's `looking up order` line at info
  level, `explicit`'s two error-level lines, each tagged
  `flue.instance.id: demo-1` and linked to its trace.
- **Issues**: exactly one, from `boom` — `intentional explosion for the
Sentry demo` with the throw-site stack. The `flue.instance.id` tag is
  the conversation id from the URL; `flue.submission.id` matches the
  `202` admission response.

## Adapting this to your project

Run `flue add tooling sentry` to apply the
[blueprint](../../blueprints/tooling--sentry.md) this example is built
from — it handles both the Node and Cloudflare targets. Or copy
`src/sentry.ts` and the `import './sentry.ts';` line into your own app
and adjust:

1. The env-var surface (`.env.example` documents each knob).
2. The `scrub(...)` redaction list, for your application's sensitive
   keys.
3. Which events raise issues — the bridge documents what each branch
   does.

There is nothing to do on a per-agent basis.
