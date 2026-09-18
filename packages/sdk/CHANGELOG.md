# @flue/sdk

## 2.1.0-next.1

### Patch Changes

- 11e1323: The MCP guide and Agent API reference now document preserved MCP tool annotations, including how trusted applications can inspect them and why server-supplied hints are not a security boundary.

## 2.1.0-next.0

### Patch Changes

- 4def7b6: The OpenTelemetry ecosystem page and Cloudflare target guide now document `contentBudgetBytes` on `createOpenTelemetryInstrumentation()` / `createCloudflareTracing()`: an override for the default 56 KiB per-span content pool. Raising it ships fuller content only on backends not bound by workerd's span cap (the OpenTelemetry adapter); on the Cloudflare target it is a tightening control only, since workerd's 64 KiB span-attribute cap is a platform limit no setting raises.
- 12464d7: The Tools guide and agent API reference now document `timeoutMs` on tool definitions: a per-call execution bound that aborts the tool's `context.signal` and settles the call with a `ToolTimeoutError` instead of letting one hung call consume the submission's durability budget.

## 2.0.8

### Patch Changes

- 9d649bc: The Cloudflare Sandbox documentation page now presents `flue add sandbox cloudflare` as a copyable prompt for your coding agent, with an explainer of what the blueprint-driven agent may do — installing `@cloudflare/sandbox`, wiring the Durable Object binding, migration, and container `Dockerfile`, and updating the agent to use the sandbox.

## 2.0.7

### Patch Changes

- 1f6238a: Installed packages once again include the bundled Flue documentation, so commands such as `flue docs read guide/sandboxes` work out of the box.
- ef0c89f: Fix delayed reconnects in `observe()`: after a stream has been healthy for a full stream lifetime, the reconnect backoff resets, so a subsequent disconnect reconnects promptly instead of applying a stale delay.

## 2.0.6

### Patch Changes

- Published packages once again include the bundled Flue documentation.

## 2.0.5

### Patch Changes

- Published packages once again resolve internal Flue dependencies to the release version.

## 2.0.2

### Patch Changes

- New docs reference page: [Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/).

## 2.0.0

### Patch Changes

- The direct agent HTTP wire body is a `DeliveredMessage`.
- Direct agent prompts are fire-and-forget only.
- The SDK's `prompt()` is removed.
- The SDK's `wait()` no longer resolves with a result.
- Idempotent delivery: name a send with `idempotencyKey` and retries converge instead of duplicating turns.
- Public conversation messages now expose typed `purpose` and `display`, plus optional `turnId` grouping and a `signal` descriptor.
- Internally-logged error responses now carry a correlation ref.
- Queue activity and recovery failures are first-class runtime events.
- Instance creation data and incarnation-conditional sends.
- In-process `observe()` now receives streaming tool-call argument deltas.
- The SDK client gains `read(admission | submissionId, options?)` — the HTTP counterpart of the handle's `read()`.
- Completed assistant messages now preserve their `submissionId` in conversation `history()` snapshots.
- Documented the supported pattern for reaching a private Flue agent over a Cloudflare service binding: point the `@flue/sdk` client's `fetch` option at the binding (#408).
- The SDK client's `read()` rejects an admission that belongs to a different conversation.
- The SDK's `wait()` (and the new `read()`) now recognize a settlement folded into a `conversation-reset` snapshot.
- Failed and aborted turns are now structurally detectable via a `settlement` marker on the terminal advisory.
- A live conversation stream can no longer stall silently forever.
- A conversation stream that is reset and regrown under a live observer is now detected and recovered automatically.
- The SDK's `observe()` no longer treats every 401/403 as permanently fatal.
- The settlement followers — the SDK client's `wait()` and `read()` — carry the same stall, auth, and stream-reset resilience as `observe()`.
- The dev-mode lifecycle logger is now an `observe()` subscriber over `submission_running`/`submission_recovery`.
- A queued submission that can never be claimed is no longer un-terminable.
