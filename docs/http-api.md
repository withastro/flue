# Flue HTTP API

Flue builds a small HTTP surface into every generated server. Use it when an
external system needs to invoke an agent, stream foreground progress, fire a
background webhook, or inspect the persisted event log for a run.

For humans and CI scripts, prefer the CLI:

```bash
flue run hello --target node --id test-1 --payload '{"name":"Ada"}'
flue logs hello test-1 run_01H... --follow
```

Use the raw HTTP API when you are writing your own client, webhook relay,
dashboard, or production control plane.

## Agent identity

```txt
POST /agents/<name>/<id>
```

- `<name>` is the agent file name without its extension. For example,
  `.flue/agents/support.ts` is served at `/agents/support/<id>`.
- `<id>` is the caller-owned agent instance id. Reuse a stable id to resume the
  same instance; use a new id to start a separate instance.
- In deployed builds, only agents with `triggers = { webhook: true }` are
  reachable over HTTP. Local `flue run` / `flue dev --target node` mode can
  invoke trigger-less agents for CI and development workflows.

The instance owns sandbox state. Inside the instance, `init()` creates a
harness scope, and `harness.session(name)` selects the conversation history
inside that harness.

## Request body

Agent requests accept JSON:

```bash
curl http://localhost:3583/agents/support/customer-123 \
  -H "Content-Type: application/json" \
  -d '{"message":"How do I reset my password?"}'
```

An empty POST body is legal and becomes `{}`. If a non-empty body is sent, the
request must use an `application/json` content type and contain valid JSON.

## Invocation modes

The same agent route supports three invocation modes.

### Sync

The default mode waits for the handler to finish:

```bash
curl http://localhost:3583/agents/hello/test-1 \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada"}'
```

Response:

```json
{
  "result": { "greeting": "Hello Ada" },
  "_meta": { "runId": "run_01H..." }
}
```

The response also includes `X-Flue-Run-Id`.

### Foreground stream

Send `Accept: text/event-stream` to stream run events while the handler is
running:

```bash
curl http://localhost:3583/agents/hello/test-1 \
  -H "Accept: text/event-stream" \
  -H "Content-Type: application/json" \
  -d '{"name":"Ada"}'
```

The stream emits Server-Sent Events. Each frame has an `event:` type, an `id:`
matching the event index when available, and a JSON `data:` payload.

```txt
event: run_start
id: 0
data: {"type":"run_start","runId":"run_01H...","eventIndex":0,...}

event: run_end
id: 4
data: {"type":"run_end","runId":"run_01H...","isError":false,"result":...}
```

The stream closes after `run_end`. Heartbeats are sent as SSE comments while a
run is active.

### Webhook

Send `X-Webhook: true` to enqueue the handler and return immediately:

```bash
curl http://localhost:3583/agents/triage/issue-123 \
  -H "X-Webhook: true" \
  -H "Content-Type: application/json" \
  -d '{"issueNumber":123}'
```

Response:

```json
{
  "status": "accepted",
  "runId": "run_01H..."
}
```

Webhook mode is useful when the caller should not hold an HTTP connection open.
Use the returned `runId` with the run routes below.

## Run routes

Every invocation creates a run id. The current run id is returned in the JSON
body where applicable and in the `X-Flue-Run-Id` response header.

### Get run metadata

```txt
GET /agents/<name>/<id>/runs/<runId>
```

Returns the run record for that agent instance:

```json
{
  "runId": "run_01H...",
  "instanceId": "customer-123",
  "agentName": "support",
  "status": "completed",
  "startedAt": "2026-05-13T00:00:00.000Z",
  "endedAt": "2026-05-13T00:00:03.425Z",
  "isError": false,
  "durationMs": 3425,
  "result": { "message": "..." }
}
```

`status` is one of `active`, `completed`, or `errored`.

### Replay persisted events

```txt
GET /agents/<name>/<id>/runs/<runId>/events
```

Query parameters:

- `after=<eventIndex>` returns events after that index.
- `types=tool_call,log,run_end` filters to a comma-separated set of event
  types.
- `limit=<n>` caps the response. The default is `100`; the server caps at
  `1000`.

Response:

```json
{
  "events": [
    { "type": "run_start", "runId": "run_01H...", "eventIndex": 0 },
    { "type": "run_end", "runId": "run_01H...", "eventIndex": 4 }
  ]
}
```

### Stream or resume events

```txt
GET /agents/<name>/<id>/runs/<runId>/stream
```

This returns the same SSE frame shape as foreground streaming. For active runs,
the stream replays persisted history and then tails live events until `run_end`.
For terminal runs, it replays matching history and closes.

To resume a stream, send the standard SSE `Last-Event-ID` header:

```bash
curl http://localhost:3583/agents/support/customer-123/runs/run_01H.../stream \
  -H "Accept: text/event-stream" \
  -H "Last-Event-ID: 12"
```

The server resumes after the provided event index.

## Events

Events are JSON objects with a `type`. Flue decorates emitted events with:

- `runId`
- `eventIndex`
- `timestamp`

Common event types include:

- `run_start`
- `text_delta`
- `thinking_start`, `thinking_delta`, `thinking_end`
- `tool_start`, `tool_call`
- `turn`
- `task_start`, `task`
- `operation_start`, `operation`
- `compaction_start`, `compaction`
- `log`
- `idle`
- `run_end`

Use `eventIndex` as the cursor for replay and resume. Event indexes are scoped
to a single run.

## Error responses

HTTP errors use Flue's canonical JSON envelope:

```json
{
  "error": {
    "type": "invalid_json",
    "message": "Request body must be valid JSON.",
    "details": "Send an application/json request body with valid JSON."
  }
}
```

In local Node dev mode, some errors include an additional `dev` field with
developer-only guidance. Public deployments omit that field.

Errors that happen after an SSE response has started are sent as `event: error`
frames instead of replacing the HTTP response.

## CLI logs

`flue logs` is a read-only wrapper over the run routes:

```bash
flue logs <agent> <id> <runId> [--server <url>] [--follow|-f|--no-follow] \
  [--since <eventIndex>] [--types a,b,c] [--limit <n>] \
  [--format pretty|json|ndjson]
```

Without `--follow` or `--no-follow`, the CLI checks the run status first. Active
runs are tailed; terminal runs are replayed once.
