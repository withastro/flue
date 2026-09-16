# @flue/runtime

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
