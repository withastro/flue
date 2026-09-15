# @flue/runtime

## 2.0.7

### Patch Changes

- d45e52a: Fix Cloudflare sandbox directory listings collapsing into a single entry — `readdir` results are now correctly separated.
- d45e52a: Cloudflare traces now carry submission, operation, and turn identifiers on agent, task, model, tool, and shell spans, so trace fragments can be correlated across durable invocations.
- d45e52a: Telemetry now marks model requests whose context includes a compaction summary, so compacted turns are distinguishable from ordinary ones.
- d45e52a: Fix Workers AI conversations stalling on tool-call-only turns — `null` or missing assistant content is treated as an absent text delta, and malformed non-string content is rejected with a clear error instead of being silently dropped.
- d45e52a: Terminal telemetry for persisted submissions now includes the agent's output text, matching what direct prompts report.
- d45e52a: Installed packages once again include the bundled Flue documentation, so commands such as `flue docs read guide/sandboxes` work out of the box.
- d45e52a: Restore compatibility for Cloudflare Anthropic gateway models — completions through `anthropic-gateway` continue to work with the full catalog of model options.
- d45e52a: Fix infinite recursion when a harness tool invokes another harness tool, directly or indirectly. Parallel tool calls remain independent, and unrelated tools sharing a public name are still allowed.
- d45e52a: Fix lost tool results when a submission is aborted mid-batch: completed tool calls keep their stored outcomes, and unexecuted calls are recorded as interrupted instead of being dropped.
- d45e52a: Fix submissions failing when a model length limit truncates a tool call batch — truncated batches now resume cleanly with their outcomes reconstructed instead of erroring out.
- d45e52a: Fix conversations erroring with `Cannot continue from message role: assistant` after context compaction. A completed response is now preserved through overflow compaction, so the next turn continues normally; only genuine provider overflow errors trigger a retry.
- d45e52a: Sessions that end through a terminating tool now compact their context as expected, so the next turn starts from a manageable context instead of continuing to grow.
- d45e52a: Tools without an output schema can now return union-shaped results — inferred branch unions, optional object properties, readonly arrays, and explicit `undefined` — and still typecheck, matching what the runtime actually serializes.
