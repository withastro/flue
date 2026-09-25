# @flue/cli

## 2.2.0-next.0

### Patch Changes

- Updated dependencies [54cabb7, 2663e50, 3b1adfd, 89032c5]
  - @flue/runtime@2.2.0-next.0
  - @flue/vite@2.2.0-next.0

## 2.1.1

### Patch Changes

- c5a2a72: Clarify that a skill's `allowed-tools` field is guidance. Flue accepts it for Agent Skills spec compatibility and does not enforce it; enforce authorization in your own tools and approval gates.
- d9e2ac0: Record tool arguments and results of every payload shape on the standard `gen_ai.tool.call.arguments` / `gen_ai.tool.call.result` attributes, so OTel backends can display them. The shape-based diversion to the vendor `flue.tool.call.*` fallback keys is removed — those keys are no longer emitted, and their constants are retained for source compatibility. Payloads record exactly as before: objects/arrays as JSON strings, strings byte-for-byte within the content budget, other scalars as their JSON form.
- 7841ff8: Allow Flue packages and newly scaffolded applications to share a compatible Hono installation. Hono dependencies now use `^4.12.32`, preventing fresh projects from installing a newer root Hono alongside the runtime's older exact version and failing typecheck.
- Updated dependencies [c5a2a72, 756db76, d9e2ac0, 7841ff8]
  - @flue/runtime@2.1.1
  - @flue/vite@2.1.1

## 2.1.0

### Patch Changes

- 4def7b6: The OpenTelemetry ecosystem page and Cloudflare target guide now document `contentBudgetBytes` on `createOpenTelemetryInstrumentation()` / `createCloudflareTracing()`: an override for the default 56 KiB per-span content pool. Raising it ships fuller content only on backends not bound by workerd's span cap (the OpenTelemetry adapter); on the Cloudflare target it is a tightening control only, since workerd's 64 KiB span-attribute cap is a platform limit no setting raises.
- 11e1323: The MCP guide and Agent API reference now document preserved MCP tool annotations, including how trusted applications can inspect them and why server-supplied hints are not a security boundary.
- 12464d7: The Tools guide and agent API reference now document `timeoutMs` on tool definitions: a per-call execution bound that aborts the tool's `context.signal` and settles the call with a `ToolTimeoutError` instead of letting one hung call consume the submission's durability budget.
- Updated dependencies [4def7b6, 11e1323, 12464d7, d9e7f5c]
  - @flue/runtime@2.1.0
  - @flue/vite@2.1.0

## 2.0.8

### Patch Changes

- 9d649bc: The Cloudflare Sandbox documentation page now presents `flue add sandbox cloudflare` as a copyable prompt for your coding agent, with an explainer of what the blueprint-driven agent may do — installing `@cloudflare/sandbox`, wiring the Durable Object binding, migration, and container `Dockerfile`, and updating the agent to use the sandbox.
- Updated dependencies [aaefa69, 3d7a0ef, 3a6242f, 9d649bc, 2d800f5, 3f3daae, 28e1afe, c5b1e25]
  - @flue/runtime@2.0.8
  - @flue/vite@2.0.8

## 2.0.7

### Patch Changes

- 1f6238a: Installed packages once again include the bundled Flue documentation, so commands such as `flue docs read guide/sandboxes` work out of the box.
- Updated dependencies [b8c07bb, 4b436f7, c1ceacd, c663410, 96b8f0b, 1f6238a, da7c085, 21c6240, 2227864, 68dbb37, 7527739, 750f1f1, 4a86eaa, d830034]
  - @flue/runtime@2.0.7
  - @flue/vite@2.0.7

## 2.0.6

### Patch Changes

- Published packages once again include the bundled Flue documentation.

## 2.0.5

### Patch Changes

- Published packages once again resolve internal Flue dependencies to the release version.

## 2.0.3

### Patch Changes

- The Cloudflare Agents SDK (`agents`) is now a dependency of `@flue/vite` — projects no longer declare it.

## 2.0.2

### Patch Changes

- The `cloudflare-shell` blueprint is replaced by `cloudflare-computer`.
- New docs reference page: [Agent Behavior](https://flueframework.com/docs/reference/agent-behavior/).

## 2.0.0

### Patch Changes

- Workflows are removed.
- The `@flue/dev-console` TUI package is removed.
- `flue run` is rewritten as transport-free local execution, and the CLI slims to `run`/`init`/`add`/`update`/`docs`.
- `vite dev` on the Node target now loads the project's `.env` file set into the application environment.
- `flue init` is now interactive and scaffolds the full project skeleton.
- Wrong-environment import failures now print the import chain naming the route to the problem.
