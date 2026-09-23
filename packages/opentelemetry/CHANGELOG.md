# @flue/opentelemetry

## 2.1.1

### Patch Changes

- d9e2ac0: Record tool arguments and results of every payload shape on the standard `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` attributes, so OTel backends can display them. The shape-based diversion to the vendor `flue.tool.call.*` fallback keys is removed — those keys are no longer emitted, and their constants are retained for source compatibility. Payloads record exactly as before: objects/arrays as JSON strings, strings byte-for-byte within the content budget, other scalars as their JSON form.
- Updated dependencies [c5a2a72, 756db76, d9e2ac0, 7841ff8]
  - @flue/runtime@2.1.1

## 2.1.0

### Minor Changes

- 4def7b6: Trace content budgets are now configurable. `createCloudflareTracing({ contentBudgetBytes })` and `createOpenTelemetryInstrumentation({ contentBudgetBytes })` override the default 56 KiB per-span content pool — raise it (e.g. `contentBudgetBytes: 200_000`) to ship fuller prompts and tool results to an observability backend that isn't bound by workerd's 64 KiB span-attribute cap, or tighten it. The 128-byte sentinel floor and the shared-pool semantics are unchanged.

### Patch Changes

- d9e7f5c: Fix two bugs in the configurable content budget:

  - An invalid `contentBudgetBytes` value (non-integer, too small, or too large) now throws a `TypeError` at setup instead of producing confusing trace content later.
  - The span that records conversation compaction now honors the configured budget, so its content is truncated or shipped consistently with every other span.

- Updated dependencies [4def7b6, 11e1323, 12464d7, d9e7f5c]
  - @flue/runtime@2.1.0

## 2.0.8

### Patch Changes

- Updated dependencies [aaefa69, 3d7a0ef, 3a6242f, 9d649bc, 2d800f5, 3f3daae, 28e1afe, c5b1e25]
  - @flue/runtime@2.0.8

## 2.0.7

### Patch Changes

- Updated dependencies [b8c07bb, 4b436f7, c1ceacd, c663410, 96b8f0b, 1f6238a, da7c085, 21c6240, 2227864, 68dbb37, 7527739, 750f1f1, 4a86eaa]
  - @flue/runtime@2.0.7

## 2.0.5

### Patch Changes

- Published packages once again resolve internal Flue dependencies to the release version.

## 2.0.0

### Patch Changes

- Assistant output projects as one conversation message per response.
- The `flue.dispatch.id` telemetry attribute is removed.
- Trace content is captured by default, and `@flue/opentelemetry`'s content surface collapses to `content?: false | { transform }`.
- `GEN_AI_SCHEMA_URL` is removed, and `@flue/opentelemetry`'s tracer/meter no longer declare a `schemaUrl`.
- `createCloudflareTracing()` now captures conversation content into Workers Traces by default; `content: false` restores content-free spans.
- `@flue/opentelemetry` now reserves the Stable `exception.type` attribute for the exception class name.
- Both trace backends now stamp `gen_ai.agent.name` on `execute_tool` spans and close the attribute gap with `@flue/opentelemetry`.
- Coordinator recovery failures now reach both tracing adapters and the Sentry blueprint.
- On Cloudflare, the whole agent response now runs inside the Durable Object's own alarm invocation.
