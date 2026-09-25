# @flue/sdk

## 2.2.0

### Minor Changes

- 54cabb7: Add bounded conversation history reads so long-running chats no longer transfer the whole transcript on every page load or reconnect.

  - `client.history({ limit })` reads only the newest messages. The snapshot keeps the head `offset`, the `incarnation`, and every settlement, and adds a `before` cursor.
  - `client.historyBefore(cursor, { limit })` reads older messages one page at a time. The page size is required.
  - `client.observe({ limit })` hydrates only the newest messages, then grows forward with live updates. Rehydration after a reconnect reads from the window's oldest message, so no gap opens. The runtime cuts `conversation-reset` snapshots to the same window. The observed state's `before` cursor feeds `historyBefore()`, and a changed cursor means the window re-based.
  - A window never cuts out a message that can still receive live updates, such as a response still streaming above messages delivered after it. It may hold more than `limit` messages.
  - Cursors are opaque and bound to one stream generation. After the stream is reset and regrown, reads with an old cursor are rejected with `history_cursor_not_found` (410), even when message ids repeat, and `observe()` re-bases.
  - `readSubmissionReply()` now requires `settlements`, so history pages are not accepted. It falls back to the latest assistant message only on a complete conversation, never on a bounded window where that message may belong to another submission.

  Unbounded reads are unchanged. `@flue/react` still observes the whole conversation.

- 2663e50: Support document attachments (PDFs) on user messages. `DeliveredAttachment` is now a union of image and document attachments — `{ type: 'document', data, mimeType: 'application/pdf', filename? }` — accepted on `dispatch()`, the `init()` handle, and direct HTTP prompts. `session.prompt()`, `skill()`, and `task()` gain a `documents` option alongside `images`, and `@flue/react`'s `sendMessage()` gains a `documents` option. Documents are forwarded to the model as native document content: Anthropic `document` blocks, OpenAI (and Azure OpenAI) Responses `input_file` parts, and Google `inlineData`. On other model APIs the document is replaced in model context with a text placeholder saying it was omitted. Documents are stored like images — as canonical attachments projected as `file` parts with `mediaType: 'application/pdf'` — so existing conversations and persistence adapters need no migration. The SDK also exports `DeliveredImageAttachment` and `DeliveredDocumentAttachment`.
- 3b1adfd: Conversation messages now carry a server-authored `timestamp` (ISO 8601 capture time of the underlying durable record) in `history()`, `observe()`, and `useFlueAgent`. It works for every role and for existing conversations. `metadata` remains entirely agent-authored. Conversation settlements carry the same `timestamp` for when the submission settled.

## 2.1.1

### Patch Changes

- c5a2a72: Clarify that a skill's `allowed-tools` field is guidance. Flue accepts it for Agent Skills spec compatibility and does not enforce it; enforce authorization in your own tools and approval gates.
- d9e2ac0: Record tool arguments and results of every payload shape on the standard `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` attributes, so OTel backends can display them. The shape-based diversion to the vendor `flue.tool.call.*` fallback keys is removed — those keys are no longer emitted, and their constants are retained for source compatibility. Payloads record exactly as before: objects/arrays as JSON strings, strings byte-for-byte within the content budget, other scalars as their JSON form.

## 2.1.0

### Patch Changes

- 4def7b6: The OpenTelemetry ecosystem page and Cloudflare target guide now document `contentBudgetBytes` on `createOpenTelemetryInstrumentation()` / `createCloudflareTracing()`: an override for the default 56 KiB per-span content pool. Raising it ships fuller content only on backends not bound by workerd's span cap (the OpenTelemetry adapter); on the Cloudflare target it is a tightening control only, since workerd's 64 KiB span-attribute cap is a platform limit no setting raises.
- 11e1323: The MCP guide and Agent API reference now document preserved MCP tool annotations, including how trusted applications can inspect them and why server-supplied hints are not a security boundary.
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
