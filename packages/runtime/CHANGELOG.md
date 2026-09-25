# @flue/runtime

## 2.2.0-next.0

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

### Patch Changes

- 89032c5: Adds support for GPT-6 Sol, GPT-6 Luna, and Claude Opus 5.5. Flue now uses Pi 0.87.1, so you can pass these models to `useModel()` without extra configuration. The model list at `https://flueframework.com/models.json` also includes them now. There are no public API changes.

## 2.1.1

### Patch Changes

- c5a2a72: Clarify that a skill's `allowed-tools` field is guidance. Flue accepts it for Agent Skills spec compatibility and does not enforce it; enforce authorization in your own tools and approval gates.
- 756db76: Make trace content truncation scale linearly for long message arrays. Large traced conversations no longer repeatedly serialize the remaining history while fitting `gen_ai.input.messages` to the attribute budget, avoiding request latency and Cloudflare Durable Object CPU-limit resets.
- d9e2ac0: Record tool arguments and results of every payload shape on the standard `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` attributes, so OTel backends can display them. The shape-based diversion to the vendor `flue.tool.call.*` fallback keys is removed — those keys are no longer emitted, and their constants are retained for source compatibility. Payloads record exactly as before: objects/arrays as JSON strings, strings byte-for-byte within the content budget, other scalars as their JSON form.
- 7841ff8: Allow Flue packages and newly scaffolded applications to share a compatible Hono installation. Hono dependencies now use `^4.12.32`, preventing fresh projects from installing a newer root Hono alongside the runtime's older exact version and failing typecheck.

## 2.1.0

### Minor Changes

- 4def7b6: Trace content budgets are now configurable. `createCloudflareTracing({ contentBudgetBytes })` and `createOpenTelemetryInstrumentation({ contentBudgetBytes })` override the default 56 KiB per-span content pool — raise it (e.g. `contentBudgetBytes: 200_000`) to ship fuller prompts and tool results to an observability backend that isn't bound by workerd's 64 KiB span-attribute cap, or tighten it. The 128-byte sentinel floor and the shared-pool semantics are unchanged.
- 11e1323: Tools returned by `createMcpConnection()` now retain the metadata sent by the MCP server in its `tools/list` response. The metadata is available on each Flue tool as `tool.annotations`:

  ```ts
  const connection = await createMcpConnection(definition);
  const deleteIssue = connection.tools.find((tool) => tool.name.endsWith('delete_issue'));

  console.log(deleteIssue?.annotations?.destructiveHint); // true
  ```

  `defineTool()` and `useTool()` also accept `annotations`, so wrappers can carry the metadata forward. Flue does not automatically change a tool's behavior based on these server-supplied values.

- 12464d7: Tools can now declare a `timeoutMs` execution bound: on expiry the harness aborts the tool's `context.signal` and settles the call with a `ToolTimeoutError` (the model sees `Tool "<name>" timed out after <ms>ms` and the conversation continues) instead of letting one hung call consume the submission's durability budget.

  ```ts
  import { defineTool } from '@flue/runtime';
  import * as v from 'valibot';

  export const lookupCatalog = defineTool({
    name: 'lookup_catalog',
    description: 'Query the upstream catalog API.',
    input: v.object({ sku: v.string() }),
    timeoutMs: 15_000,
    async run({ data, signal }) {
      // If this call exceeds 15s, `signal` aborts, the call settles with a
      // ToolTimeoutError the model sees, and the conversation continues —
      // the model can retry or change approach.
      const response = await fetch(`https://catalog.example.com/${data.sku}`, { signal });
      return { output: await response.json() };
    },
  });
  ```

### Patch Changes

- 4def7b6: The OpenTelemetry ecosystem page and Cloudflare target guide now document `contentBudgetBytes` on `createOpenTelemetryInstrumentation()` / `createCloudflareTracing()`: an override for the default 56 KiB per-span content pool. Raising it ships fuller content only on backends not bound by workerd's span cap (the OpenTelemetry adapter); on the Cloudflare target it is a tightening control only, since workerd's 64 KiB span-attribute cap is a platform limit no setting raises.
- 11e1323: The MCP guide and Agent API reference now document preserved MCP tool annotations, including how trusted applications can inspect them and why server-supplied hints are not a security boundary.
- 12464d7: The Tools guide and agent API reference now document `timeoutMs` on tool definitions: a per-call execution bound that aborts the tool's `context.signal` and settles the call with a `ToolTimeoutError` instead of letting one hung call consume the submission's durability budget.
- d9e7f5c: Fix two bugs in the configurable content budget:

  - An invalid `contentBudgetBytes` value (non-integer, too small, or too large) now throws a `TypeError` at setup instead of producing confusing trace content later.
  - The span that records conversation compaction now honors the configured budget, so its content is truncated or shipped consistently with every other span.

## 2.0.8

### Patch Changes

- aaefa69: Interrupted submissions no longer retry forever when the recovery render throws: once the submission's durability deadline passes, a submission whose classification render keeps failing is settled as timed out instead of being re-rendered on every supervisor wake without ever consuming an attempt.
- 3d7a0ef: The Cloudflare binding's Anthropic gateway path now maps the agent's `thinkingLevel` to an adaptive-thinking effort (`output_config.effort`), so `useModel` thinking levels take effect on adaptive-thinking models instead of always running at Anthropic's default.
- 3a6242f: The Cloudflare binding provider now accepts a `cacheRetention` option (`'short'` or `'long'`) to enable Anthropic prompt caching for `anthropic/…` gateway models — repeated prefixes are served from cache at the cached input rate instead of paying full input price every turn. Default `'none'` keeps the previous behavior.
- 9d649bc: The Cloudflare Sandbox documentation page now presents `flue add sandbox cloudflare` as a copyable prompt for your coding agent, with an explainer of what the blueprint-driven agent may do — installing `@cloudflare/sandbox`, wiring the Durable Object binding, migration, and container `Dockerfile`, and updating the agent to use the sandbox.
- 2d800f5: Fix the first streamed delta being delayed by the full coalescing interval: after a quiet period, the first delta now flushes to the durable stream immediately, so observers see output as soon as the model starts responding.
- 3f3daae: Fix duplicate responses appearing after a model stream fails partway through and Flue retries it successfully. Clients now see only the successful replacement response instead of the incomplete first attempt followed by the complete retry.
- 28e1afe: Models synthesized from a dynamic model template (providers that serve model IDs beyond their catalog, such as Workers AI) are now detectable via the exported `isDynamicModel()` helper, and the runtime warns once when such a model is first resolved — previously their cost silently read as $0 with no way to tell "free" apart from "unknown".
- c5b1e25: GenAI trace content now stays schema-valid when it cannot be fully represented: oversized, unserializable, or transform-failing messages under `gen_ai.input.messages` / `gen_ai.output.messages` fall back to a shape-preserving `role: "flue"` message (output fallbacks keep `finish_reason`) instead of a bare diagnostic string or an array element that violates the message schema.

## 2.0.7

### Patch Changes

- b8c07bb: Fix Cloudflare sandbox directory listings collapsing into a single entry — `readdir` results are now correctly separated.
- 4b436f7: Cloudflare traces now carry submission, operation, and turn identifiers on agent, task, model, tool, and shell spans, so trace fragments can be correlated across durable invocations.
- c1ceacd: Telemetry now marks model requests whose context includes a compaction summary, so compacted turns are distinguishable from ordinary ones.
- c663410: Fix Workers AI conversations stalling on tool-call-only turns — `null` or missing assistant content is treated as an absent text delta, and malformed non-string content is rejected with a clear error instead of being silently dropped.
- 96b8f0b: Terminal telemetry for persisted submissions now includes the agent's output text, matching what direct prompts report.
- 1f6238a: Installed packages once again include the bundled Flue documentation, so commands such as `flue docs read guide/sandboxes` work out of the box.
- da7c085: Restore compatibility for Cloudflare Anthropic gateway models — completions through `anthropic-gateway` continue to work with the full catalog of model options.
- 21c6240: Fix infinite recursion when a harness tool invokes another harness tool, directly or indirectly. Parallel tool calls remain independent, and unrelated tools sharing a public name are still allowed.
- 2227864: Fix lost tool results when a submission is aborted mid-batch: completed tool calls keep their stored outcomes, and unexecuted calls are recorded as interrupted instead of being dropped.
- 68dbb37: Fix submissions failing when a model length limit truncates a tool call batch — truncated batches now resume cleanly with their outcomes reconstructed instead of erroring out.
- 7527739: Fix conversations erroring with `Cannot continue from message role: assistant` after context compaction. A completed response is now preserved through overflow compaction, so the next turn continues normally; only genuine provider overflow errors trigger a retry.
- 750f1f1: Sessions that end through a terminating tool now compact their context as expected, so the next turn starts from a manageable context instead of continuing to grow.
- 4a86eaa: Tools without an output schema can now return union-shaped results — inferred branch unions, optional object properties, readonly arrays, and explicit `undefined` — and still typecheck, matching what the runtime actually serializes.

## 2.0.6

### Patch Changes

- Published packages once again include the bundled Flue documentation.

## 2.0.5

### Patch Changes

- Published packages once again resolve internal Flue dependencies to the release version.

## 2.0.4

### Patch Changes

- `"Connection error."` is now classified as a retryable model error.

## 2.0.2

### Patch Changes

- Conditional tool additions are now cache-safe on models with deferred tool loading.
- Cloudflare trace spans whose terminal event never arrives are force-closed when the submission settles.
- The sandbox types are renamed to match their roles; the old names remain as deprecated aliases.
- New docs reference page: [Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/).

## 2.0.1

### Patch Changes

- Reasoning effort sent through the Workers AI binding's Responses wire format is now clamped to the `/run` endpoint's `none|low|medium|high` ceiling.
- A durable submission can no longer sit unsettled forever behind a hung await.
- The awaits that could stall an attempt now bound themselves, so a stall recovers in seconds-to-minutes instead of failing at the durability deadline.
- Settlement events no longer vanish in an invocation's final moments.

## 2.0.0

### Patch Changes

- File-based routing is removed — `app.ts` is the route map.
- The tool `run()` context and the harness are reshaped.
- Sandboxes are opt-in: an agent that declares no `useSandbox()` has no execution environment.
- Skill and markdown imports drop their import attributes — the specifier decides.
- MCP servers are declared as connection definitions; `connectMcpServer` is removed.
- Model providers are Pi-native: `registerProvider` and `registerApiProvider` are removed, and the `providers` list is exhaustive.
- `dispatch()` takes a structured `message`, not an opaque `input`.
- `dispatch()` targets an agent definition, not a name string.
- Signal `tagName` must be a valid XML tag name.
- `AttachedAgentEventCallback` type removed from `@flue/runtime`.
- `reconcileInterruptedSubmission` return type simplified.
- The `init()` handle's `dispatch()` is enqueue-only; awaiting the reply is the new `read()`.
- One id vocabulary end to end: `dispatchId` is renamed `submissionId`.
- `FlueEvent` no longer has a `dispatchId` correlation field.
- Persisted stores are stamped `format_version` 1, and stores written by 1.0.0-beta.x are rejected.
- A tool's `run()` returns a result envelope — `{ output?, terminate? }` — and bare non-string values are rejected.
- `SessionEnv.exec` now rejects promptly on abort — an un-cancellable sandbox command becomes a documented orphan.
- New `@flue/runtime/telemetry` subpath: the backend-neutral GenAI content machinery shared by the trace backends.
- Agents deployed to Cloudflare are traced with no wiring — enable Workers Traces and each response carries the `invoke_agent`/`chat`/`execute_tool` spans.
- The Node dev server's 503 "runtime unavailable" envelope now carries the underlying application load failure.
- `start()` and `init()`: the programmatic agent client.
- `durable: true` tools get checkpointed steps.
- A message that arrives while its conversation is busy can join the live response.
- Updated `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 0.83.0.
- Conversation reads and cold starts no longer replay the whole record log; resident state is served from a shared fold with durable checkpoints.
- Terminalizing a durable agent submission settles its conversation to a deterministic rest state instead of leaving dangling tool calls.
- MCP tool connections no longer crash on Cloudflare Workers when a connected server advertises a tool `outputSchema`.
- Tool-call duration is now durably recorded and surfaced as `durationMs` on the resolved `dynamic-tool` part.
- The Cloudflare extension's `base` and `wrap` callbacks are now typed against the concrete generated Durable Object constructor.
- Documented the `kind: 'user'` vs `kind: 'signal'` convention.
- A joined submission's reply is now resolved through its settlement's derived linkage instead of by recency.
- Removed dead per-submission result computation left behind by the result-await removal.
- A bare `"Provider finish_reason: error"` — how pi-ai's OpenAI-compatible layer reports an aggregator (e.g.
- Server-side error logs are now cause-chain faithful across every `cause` level.
- A settlement recovered from the crash window between reserve and finalize now publishes the live `submission_settled` event.
- A joined delivery's live `submission_settled` event now carries the joined submission's own `submissionId`.
- The `local()` sandbox now resolves a command killed by its `timeoutMs` deadline with exit code 124.
- Sandbox operations can no longer hang forever when the sandbox dies mid-call.
- Conversation batches larger than Cloudflare Durable Object SQLite's ~2 MB per-value cap no longer fail the append with a raw `SQLITE_TOOBIG`.
- Admission owns instance identity, so a submission no longer initializes the root harness twice before its first model turn.
- Conversation loads fold in place instead of cloning the reduced state once per stored batch.
- A model-invoked `task` call naming an agent outside the declared roster returns a plain tool result instead of throwing.
- A Workers AI stream that ends with no error frame and no `finish_reason` is now retried instead of hard-failing the submission.
- AI Gateway models work fully through the Workers AI binding provider — gateway ids resolve with real metadata and `openai/` models use the Responses wire format.
