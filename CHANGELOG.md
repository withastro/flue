# Changelog

## Unreleased

### Breaking Changes

- **Addressable agents and workflow harnesses now use separate initialization APIs.** Reserve `createAgent(...)` for default exports from `agents/<name>.ts`; its initializer receives only the stable agent instance `id` and platform `env`. Workflows now pass `AgentRuntimeConfig` directly to `ctx.init({ ... })`, where they can build invocation-local configuration from `ctx.payload`, `ctx.env`, and other workflow state. Migrate `const agent = createAgent(() => config); await ctx.init(agent)` to `await ctx.init(config)`. Workflow `ctx.payload` is unchanged.

## 1.0.0-beta.2 - 2026-06-17

### Fixes & Other Changes

- Fixed model-invoked `task` calls being unable to pass images from the current conversation to a child agent. Flue now exposes stable attachment IDs alongside image prompts and accepts `attachments: [{ id }]`, including across session reloads while the image remains visible in the calling session's model context.

## 1.0.0-beta.1 - 2026-06-16

### Breaking Changes

- **Persistence adapters now use one async `connect()` contract.** Custom adapters return `executionStore`, `runStore`, and `eventStreamStore` together; `RunRegistry` is removed in favor of `RunStore`, and adapters must stamp and check schema versions.
- **Workflow run APIs are simplified.** Run IDs are now opaque `run_<ulid>` values, invocation responses use one flat `{ streamUrl, offset, runId? }` envelope, and `GET /runs/:runId?meta` replaces the removed admin run API. `admin()`, `client.admin.*`, `adminBasePath`, and related docs are removed.
- **Tool and timeout APIs changed.** `defineTool({ parameters })` now uses valibot instead of TypeBox, the root `Type` export is removed, duration fields are `timeoutMs`, and durability `retry` becomes `maxAttempts`.
- **Cloudflare and sandbox cleanup.** `cloudflareSandbox()` replaces the workerd stub heuristic; `getVirtualSandbox`, `sandbox: false`, and expired sandbox migration shims are removed.
- **Session and event contracts are tightened.** Public session operations expose `FlueSession`, subagent profiles are self-contained, session errors are typed, and durable events now carry `v: 1` without persisting `turn_request`, `message_update`, or raw `assistantMessageEvent` payloads. Streaming deltas are best-effort live progress; `message_end` is authoritative for completed assistant messages, and late attachment may miss earlier partial output until it arrives. Internal interrupted-turn recovery is unaffected.
- **Cloudflare extension imports moved.** Generated-entry plumbing now lives under `@flue/runtime/cloudflare/internal`; user-facing Cloudflare imports remain authoring-only.
- **GitHub handlers now receive provider-native deliveries.** Replace `{ c, event }` with `{ c, delivery }`; branch on `delivery.name` and native `delivery.payload` fields instead of Flue's normalized `event.type`, `event.payload`, and `event.raw` wrappers. The fixed event allowlist, synthetic `unknown` variant, form-encoded ingress, and `handlerTimeoutMs` are removed.
- **Slack handlers now receive provider-native payloads.** `events`, `interactions`, and `commands` use `{ c, payload }`; Events API callbacks expose the official `SlackEvent` union, and normalized wrappers, fixed-workspace filtering, package timeouts, and legacy interaction types are removed.
- **Discord handlers now receive provider-native interactions.** Callbacks preserve Discord API v10 fields and numeric discriminants; normalized wrappers, redundant application-id filtering, the non-cancelling package timeout, and redundant guild channel/thread identity are removed.
- **Google Chat handlers now receive provider-native deliveries.** Direct interactions use `{ c, payload }`, wrapped Workspace Events use `{ c, delivery }`, and normalized event wrappers and the non-cancelling package timeout are removed.
- **`observe()` now receives every event directly.** The `types` filter and per-subscriber JSON snapshots are removed; callbacks should branch on `event.type` and treat events as read-only.

### New Features

- Built-in `sqlite()` now persists workflow runs and indexes, matching PostgreSQL and Cloudflare durability; all built-in SQL stores now schema-version stamp.
- `@flue/runtime` exports `listRuns()`, `getRun()`, and `listAgents()`; SDK `runs.get()` uses public `?meta`; workflow `wait=result` and typed direct-agent prompt responses are supported.
- `CallHandle` now implements the full Promise interface, and SDK stream coordinates are taken from server responses rather than fabricated.
- `FlueFs.writeFile()` now guarantees parent directory creation in every sandbox mode; `ShellOptions.timeoutMs` is available for shell operations.
- OpenTelemetry spans and attributes now align with GenAI semconv.
- Added `@flue/react` with `FlueProvider`, `useFlueAgent()`, and `useFlueWorkflow()` for live agent transcripts and workflow-run observation. Agent messages use an AI SDK v5-compatible parts shape without a runtime dependency on `ai`.
- Added first-party `@flue/stripe`, `@flue/notion`, `@flue/resend`, `@flue/shopify`, `@flue/intercom`, `@flue/zendesk`, `@flue/salesforce`, `@flue/teams`, `@flue/google-chat`, `@flue/linear`, `@flue/telegram`, `@flue/whatsapp`, `@flue/twilio`, and `@flue/messenger` packages for verified HTTP ingress, constructor-owned typed handlers, canonical provider identity where available, and discovered `channels/<name>.ts` routing. Existing `@flue/github`, `@flue/slack`, and `@flue/discord` packages were rewritten and expanded around the same channel contract. Named `flue add` blueprints create editable project code using provider SDK or Fetch clients and application-owned tools.
- `flue add <kind> <name|url>` now serves categorized channel, database, and sandbox blueprints. `flue update <kind> <name|url>` returns the same current guide with versioned primary-file markers and cumulative upgrade instructions so coding agents can update generated integrations while preserving application customizations.
- Added driver-free `@flue/mysql`, `@flue/redis`, and `@flue/mongodb` persistence adapters with durable sessions, submissions, workflow runs, event streams, and image chunks. New database blueprints and ecosystem guides cover MySQL, Supabase, Redis, Valkey, and MongoDB.
- Durable event-stream reads accept `tail=N` to start from the beginning while reading at most the latest N events. Direct agent prompt receipts and their emitted events now expose a `submissionId` for reliable correlation.
- `@flue/sdk` accepts browser-relative base URLs such as `/api`, exposes typed message snapshots, and supports `tail` across stream APIs.

### Fixes & Other Changes

- The WhatsApp channel now accepts Business-Scoped User ID webhook payloads
  when Meta omits phone-number fields, preserves BSUID and parent-BSUID
  metadata, and uses collision-safe phone, BSUID, and group conversation
  identities. Its editable client example sends BSUID messages through the
  SDK's authenticated low-level request path.
- Channel routing now accepts valid Fetch responses across JavaScript realm
  boundaries while continuing to reject tagged non-response objects.
- Recovery now resumes shutdown-interrupted turns, settles completed work before budget or timeout checks, repairs partial tool batches without replaying completed tools, and emits durable submission-settlement events for waiters.
- Cloudflare attempt markers are now Flue-owned rather than querying private Agents SDK tables.
- `flue logs` treats `--since` as an opaque Durable Streams offset, supports `--format ndjson`, and uses public run metadata.
- Many bug fixes landed across Node and Cloudflare execution, SDK stream iteration, CLI shutdown and reload, Workers AI streaming, sandbox filesystem behavior, skill parsing, docs, and test coverage.
- Updated `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 0.79.4, and aligned the documented Node.js minimum with their `>=22.19.0` requirement.
- Skills can now be imported from npm and workspace packages through Vite resolution; package-manager symlinks are supported, and packaged skill identity is derived from deployed content.
- Added a same-origin React chat example with agent conversation and workflow log views.

## 0.11.1 - 2026-06-11

### New Features

- Direct agent HTTP requests and `@flue/sdk` prompts can include images with up to 14 MiB of encoded data per image. Node and Cloudflare SQLite persistence stores image data in safe chunks and restores it for future turns and after restarts.

### Fixes & Other Changes

- The grep tool now uses ripgrep when available, falls back to grep, treats patterns as extended regular expressions by default, and supports literal matching.
- SQL-backed sessions now store each history entry in its own row instead of rewriting the entire session history as one JSON value. Session saves remain transactional and preserve ordered history across Cloudflare Durable Object SQLite, Node SQLite, and PostgreSQL.

## 0.11.0 - 2026-06-09

### New Features

- **`flue docs` browses the documentation offline.** The docs markdown already shipped inside `@flue/cli` is now reachable from the command line: `flue docs` lists every page, `flue docs read <path>` prints one page as Markdown, and `flue docs search <query>` prints ranked JSON results. Content requires no network access and always matches the installed CLI version. Designed for coding agents (search → read), per [Documentation](https://flueframework.com/docs/cli/docs/).

### Fixes & Other Changes

- Runtime events no longer carry raw image bytes (#221). Image content blocks in session events (`message_*`, `turn_request`, `turn_end`, `agent_end`, `tool_call`) keep their `mimeType` but have `data` replaced with the exported `IMAGE_DATA_OMITTED` sentinel before events reach observers and persisted run history. Model context and persisted session history retain the real bytes. Events persisted before this change are unaffected.
- Updated `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 0.79.1.

## 0.10.2 - 2026-06-09

### Fixes & Other Changes

- Fixed workflow run-event persistence issuing one durable storage write per streamed chunk. Per-chunk streaming events (`text_delta`, `thinking_start`, `thinking_delta`, `thinking_end`) are now buffered and flushed to the event stream store at most once every 3 seconds instead of on every chunk. Live stream readers still see deltas; history replay and interrupted-stream recovery are unaffected.

### Breaking Changes

- **Durable Streams protocol replaces WebSocket and SSE transports.** Agent instances and workflow runs are now URL-addressable durable event streams. Clients consume events via DS-compliant `GET` (catch-up, long-poll, SSE) with automatic offset-based reconnection. `POST /agents/:name/:id` now returns `202 { streamUrl, offset }`; add `?wait=result` for `200 { result, streamUrl, offset }`. `GET /agents/:name/:id` reads the event stream. `GET /runs/:runId` replaces both `/runs/:runId/events` and `/runs/:runId/stream`. WebSocket transport, `AgentSocket`, `WorkflowSocket`, and all socket-related types are removed from `@flue/runtime` and `@flue/sdk`.
- **Named sessions removed from agent public API.** The `session` parameter is removed from prompt submission, dispatch, SDK, and CLI. Agent instances always use the `"default"` session internally. An agent instance is now a single conversation with a single event stream.
- **SDK rewritten with `@durable-streams/client`.** `@flue/sdk` now exports `agents.prompt()`, `agents.send()`, `agents.stream()`, `runs.stream()`, `runs.events()`, and `workflows.invoke()`. `agents.prompt()` waits for the result; `agents.send()` returns stream coordinates immediately. `FlueEventStream<T>` wraps the DS client's `jsonStream()` as an async iterable with `cancel()` and `offset` support.
- **`connectEventStreamStore()` is now required on `PersistenceAdapter`.** Custom adapters must implement this method and provide durable event-stream storage. The built-in `sqlite()` and `@flue/postgres` adapters provide implementations.
- **`client.runs.get()` now reads from the admin mount.** Applications using that SDK method must mount `admin()` and configure the client with the matching admin base path.

### New Features

- **`@flue/postgres` supports durable event streams.** `PgEventStreamStore` provides a Postgres-backed implementation of `EventStreamStore` with transactional `appendEvent`, in-process subscriber hooks, and full DDL in the existing migration transaction. Postgres deployments now have working `GET` stream endpoints for agents and workflow runs.
- **DS protocol read endpoints.** `GET` supports catch-up (JSON array), long-poll (30s timeout with `Stream-Cursor`), and SSE (with 15s heartbeat and control events). `HEAD` returns stream metadata. Responses include `Stream-Next-Offset`, `Stream-Up-To-Date`, `Stream-Closed`, `ETag`, and `Cache-Control` headers per the DS protocol spec. Reads use `Cache-Control: no-store`; there is no fallback polling path when a live subscription is unavailable.

### Fixes & Other Changes

- **`RunStore` reduced to metadata only.** `appendEvent()` and `getEvents()` removed; events are exclusively in `EventStreamStore`. `RunSubscriberRegistry` deleted.
- **Agent POST responses are now split by wait mode.** Default agent POST returns `202` with stream coordinates; `?wait=result` returns the terminal result. Event observation is decoupled from POST responses via the DS stream read path.
- **`SqliteEventStreamStore` creates its own tables in the constructor.** No separate `ensureEventStreamTables()` call required; removed from `ensureSqlAgentExecutionTables()` and `@flue/runtime/internal` exports.
- **`flue logs` rewritten to use `@flue/sdk` DS streaming.** Removed dead `--session` flag.
- Fixed stale WebSocket references in documentation, README, and generated entry code.

## 0.10.1 - 2026-06-08

### Fixes & Other Changes

- Fixed generated Node and Cloudflare app entrypoints by avoiding collisions with application-owned `app` bindings.
- Updated `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core` to 0.79.0.
- Fixed typos in documentation: "truely", "exited", and "suitible" (#211).
- Fixed docs search dialog throwing `InvalidStateError` when `Cmd/Ctrl+K` is pressed while already open (#214).
- Fixed SSE parser missing frame boundaries when CRLF is split across stream chunks or when using CR-only line endings (#216).
- Added `deleted_classes` and `renamed_classes` migration examples to the Cloudflare target documentation (#203).

## 0.10.0 - 2026-06-08

This is a large pre-1.0 release that establishes Flue's durability model across Node.js and Cloudflare. Rather than cataloging every intermediate beta change, this entry highlights the final APIs and the most important upgrade work. For guides and API reference, see the [documentation](https://flueframework.com/docs/).

### Breaking Changes

- **Cloudflare durable deployments require a migration.** Generated Durable Object bindings and class names changed to `FLUE_<NAME>_AGENT`, `FLUE_<NAME>_WORKFLOW`, `FLUE_REGISTRY`, `Flue<Name>Agent`, `Flue<Name>Workflow`, and `FlueRegistry`. Existing deployments must add authored Wrangler `renamed_classes` migrations for already-deployed agent and workflow classes, update direct binding access such as `env.Assistant` to `env.FLUE_ASSISTANT_AGENT`, and introduce fresh SQLite-backed agent classes through `new_sqlite_classes`; existing KV-backed classes cannot be converted in place. Install `agents >=0.14.1 <0.15.0` for the audited Agents SDK behavior used by this release.
- **Runtime surface cleanup.** Removed `tool_execution_*` event types, the `@flue/runtime/app`, `@flue/runtime/client`, and `@flue/runtime/sandbox` compat subpaths, public `AgentConfig` / `DirectAgentPayload` exports, public Cloudflare agent WebSocket adapters, `store()` from `@flue/runtime/cloudflare`, and the old Cloudflare shell migration stubs.
- **Persistence adapter contracts changed.** Custom adapters now implement `connectRunStore()` and `connectRunRegistry()` on `PersistenceAdapter`, use `SubmissionClaimRef` for `claimSubmission()`, and provide `renewLeases()`, `listExpiredSubmissions()`, and `deleteSession()` on `AgentSubmissionStore`.
- **Session state changed.** Ordinary session names beginning with `task:` are now reserved for framework-owned delegated-task history, and existing version-4 beta session state is rejected because provider affinity now uses one opaque `aff_<ULID>` key instead of derived instance/harness/session identifiers.
- **OpenTelemetry sanitization changed.** `captureContent` is replaced by an application-owned `sanitize(event)` callback; metadata and generic failure messages are exported by default.

### New Features

- **Unified durable agent execution.** Direct HTTP, SSE, WebSocket, local CLI, and `dispatch(...)` inputs now share one SQL-backed submission lifecycle on Node and Cloudflare: admission, same-session ordering, claiming, journaled execution, conservative recovery, and retained terminal receipts.
- **Pluggable persistence.** Add source-root `db.ts` adapters, built-in `sqlite(path?)` persistence for Node, the new `@flue/postgres` package, and the `@flue/runtime/adapter` / `@flue/runtime/test-utils` subpaths for custom backend authors.

  ```ts
  // src/db.ts
  import { sqlite } from '@flue/runtime/node';
  export default sqlite('./data/flue.db');
  ```

  ```ts
  // src/db.ts
  import { postgres } from '@flue/postgres';
  export default postgres(process.env.DATABASE_URL!);
  ```

- **Signal messages and mid-turn recovery.** Stream chunks are persisted during provider output so interrupted turns can resume from partial assistant text. Framework-injected context now uses signal messages for stream interruption/continuation, terminal submission advisories, dispatched input, compaction summaries, and branch summaries.
- **Cloudflare extension hooks.** Agent and workflow modules may export `cloudflare = extend({ base, wrap })` from `@flue/runtime/cloudflare` to add native Agents SDK lifecycle hooks beneath Flue-owned routing or wrap generated Durable Object classes with integrations such as Sentry.

### Fixes & Other Changes

- **Node execution is concurrent and shutdown-aware.** Different sessions now process in parallel through a concurrent claim loop. Claimed submissions carry renewable leases, and SIGINT/SIGTERM drains active work at turn boundaries before reclaiming unfinished submissions on next startup.
- **Postgres workflow history is durable.** `@flue/postgres` stores runs, run events, and the run registry in SQL-backed tables; built-in SQLite keeps run history in memory.
- **Cloudflare routing and recovery are stricter.** Generated agent and workflow bindings are resolved explicitly instead of inferred from the Agents SDK environment scanner, workflow event identity is append-only by `(runId, eventIndex)`, and Cloudflare workflow storage preserves same-ID reset behavior and explicit terminal `null` results.
- **Observability is more accurate.** OpenTelemetry now closes interrupted workflow spans correctly, exposes event indexes and compaction usage, and supports `resolveRootContext(event, ctx)` for parenting Flue roots under application-owned spans.
- **Runtime resilience improved.** Prompt operations retry transient provider failures with abortable exponential backoff, generated import paths are escaped safely, and Bun compatibility diagnostics now point users at the right runtime upgrade.

## 0.9.2 - 2026-06-03

### Fixes & Other Changes

- Fixed agents' ability to activate skills autonomously with the `activate_skill` tool.

## 0.9.1 - 2026-06-02

### Fixes & Other Changes

- **Fixed relative cwd double-scoping in custom sandbox connectors.** Flue now applies a created agent's `cwd` exactly once during `init()`, relative to the connector's provider-owned base directory. `SandboxFactory.createSessionEnv()` now receives only `{ id }`; connector implementations should stop consuming `cwd` there.
- **SDK: Export reusable option types.** `@flue/sdk` now exports option types for direct agent invocation, socket prompts, workflow-run event retrieval and streaming, and admin run listing, plus the `RunStatus` type.
- MCP tools discovered through paginated listings now preserve output-schema validation and required task-execution metadata across every page.
- `GET /admin/agents` and `client.admin.agents.list()` return one unpaginated list of all built agents. The unused `nextCursor` response field was removed from the SDK and OpenAPI schema.
- Workflow run stores no longer prune completed histories implicitly after 50 runs. Retention is now owned by the deployment or configured store.
- Cloudflare agent WebSockets now return a correlated error frame when persisted session restoration fails before a prompt.
- Cloudflare WebSocket attachments strip query strings and fragments before persistence so URL-carried handshake credentials are not retained.
- Agent and workflow WebSocket frames reject blank or whitespace-only `requestId` values, including optional agent ping IDs.
- Published the Message-Driven Agents guide, Sandbox Connector API, and Daytona integration guide on the documentation site. Replace saved root-guide or raw GitHub links with [Message-Driven Agents](https://flueframework.com/docs/guide/message-driven-agents/), [Sandbox Connector API](https://flueframework.com/docs/api/sandbox-api/), and [Daytona](https://flueframework.com/docs/ecosystem/sandboxes/daytona/).
- Refreshed homepage and documentation canonical URLs and social-preview metadata.
- **Cloudflare: Extend generated deployments and addressable agents.** Add an optional source-root `cloudflare.ts` module to export application-owned Durable Objects and compose non-HTTP Worker handlers. Addressable agent modules may export `cloudflare = extend({ base, wrap })` from `@flue/runtime/cloudflare` to add native Agents SDK lifecycle hooks beneath Flue-owned routing or wrap the final generated Durable Object class with integrations such as Sentry.
- **Cloudflare Sandbox exports are now explicit.** Export Cloudflare Sandbox aliases from your source-root `cloudflare.ts` module instead of relying on the removed `Sandbox`-suffix auto-wiring.

## 0.9.0 - 2026-06-02

### Breaking Changes

- **Move application routing imports out of `@flue/runtime/app`.** Import `flue`, `admin`, and `Fetchable` from `@flue/runtime/routing`. Import provider APIs and `observe` from `@flue/runtime`, and Workers AI binding types from `@flue/runtime/cloudflare`. Rename the `ProviderSettings` type to `ProviderConfiguration`.
- **Check your authored source directory.** Flue now selects exactly one source directory in priority order: `.flue/`, `src/`, then the project root. If your project already has a `src/` directory, move root-level agents and workflows into the selected source directory so Flue continues to discover them.
- **Cloudflare: Own Cloudflare Durable Object migrations in your project Wrangler config.** Flue still generates classes and bindings, but no longer appends migrations automatically. Before upgrading an existing deployment, copy its complete ordered `flue-class-*` migration history from the previously generated `.flue-vite.wrangler.jsonc` or built `wrangler.json` into the project-root Wrangler config. Keep deployed tags unchanged, and append a uniquely tagged `new_sqlite_classes` entry whenever you add an agent or workflow class.
- **Workflows: Retry interrupted Cloudflare workflows explicitly.** Flue no longer starts a replacement workflow run automatically after an interruption. The interrupted run is recorded as failed; invoke the workflow again when retrying is appropriate. Restart-link fields and their legacy OpenTelemetry attributes were removed.
- **Agents: Clear or migrate persisted beta session state before upgrading.** Session and dispatch records from earlier beta releases are rejected rather than resumed with the new record shape. This does not apply to Flue workflows.
- **Providers: Use provider IDs consistently.** Model values use `provider-id/model-id`. `registerProvider(providerId, ...)` no longer accepts a separate `provider` override, `configureProvider(providerId, ...)` uses the same ID, and binding-backed `cloudflare/...` models now report provider ID `cloudflare`. Prompt responses now expose `model: { provider, id }`.
- **SDK: Configure SDK mount paths through `baseUrl`.** Its pathname is now used for public HTTP, SSE, and WebSocket routes. Remove `websocketBasePath`; keep `adminBasePath` only for an independent admin mount.

### New Features

- **Load local environment values before configuration.** Flue application commands load project-root `.env` values automatically. Use `--env <path>` to select one alternate file; shell values still take precedence.
- **Restart `flue dev` after configuration changes.** Creating, editing, or deleting an auto-discovered `flue.config.*` file restarts the development session with freshly resolved settings. Explicit `--config <path>` files are watched too.
- **Forward authentication headers with `flue logs`.** Repeat `--header 'Name: value'` to send application-owned headers when inspecting workflow runs. Redirects are rejected so credentials stay on the selected server.
- **Inspect admitted workflow runs from WebSocket clients.** `WorkflowSocket.runId` resolves after admission, before the workflow result arrives.
- **Catch SDK HTTP failures with `FlueApiError`.** `@flue/sdk` now exports the error type with the HTTP status and parsed response body when available.
- **Forward Workers AI reasoning effort.** Binding-backed `cloudflare/...` models now pass reasoning effort to `env.AI.run(...)` for models that support it.

### Fixes & Other Changes

- MCP connections now follow paginated tool listings so all server tools are available.
- Workflow run streams now avoid duplicate events during replay-to-live handoff and validate reconnect event IDs more strictly.
- Session lifecycle requests for the same name are serialized to avoid deletion races.
- `observe()` subscribers now receive isolated event snapshots, and rejected async callbacks no longer interrupt runtime execution.
- Improved Cloudflare upgrade safety, local development diagnostics, and handling for unusual session names.
- Fixed cwd scoping for created agents using Node `local()` sandboxes.
- Pass at most one `--env` file. `flue build`, `flue dev`, `flue run`, and `flue connect` reject repeated `--env` flags. Combine values into one file or use shell environment overrides.
- `session.delete()` and `harness.sessions.delete()` now reject while the selected session has an active operation.
- Testing: Import `registerFauxProvider(...)`, `fauxAssistantMessage(...)`, `fauxText(...)`, and `fauxToolCall(...)` from `@earendil-works/pi-ai` instead of `@flue/runtime`.

## 0.8.1 - 2026-05-28

### New Features

- **OpenTelemetry tracing integration.** Added `@flue/opentelemetry` for tracing Flue model turns through OpenTelemetry-compatible observability tooling.

### Fixes & Other Changes

- Reduced routine runtime console logging and expanded the published documentation and website guidance.

## 0.8.0 - 2026-05-27

This is a large pre-1.0 release that establishes Flue's model for building persistent agents and finite workflows. Rather than cataloging every intermediate beta change, this entry highlights the final APIs and the most important upgrade work. For guides and API reference, see the [documentation](https://flueframework.com/docs/).

### New Features

- **Distinct agents and workflows.** Files in `agents/` now define persistent, addressable agent instances with `createAgent(...)`; files in `workflows/` define finite executions with `run(...)`. Agents maintain sessions across direct interactions and dispatched inputs, while workflows own persisted runs and results.
- **Message-driven and live application surfaces.** Agents support direct HTTP prompts, asynchronous `dispatch(...)`, and WebSocket conversations. Workflows support HTTP and WebSocket invocation, and `@flue/sdk` now includes typed clients for connecting to deployed Flue applications.
- **Composable agent capabilities.** `createAgent(...)`, `defineAgentProfile(...)`, `defineTool(...)`, and named subagents provide explicit reusable building blocks for model configuration, runtime resources, tools, skills, and delegation.
- **Packaged Agent Skills and Markdown imports.** Applications can import `SKILL.md` dependencies as validated `SkillReference` values, bundle their supporting files for Node or Cloudflare, and import attributed Markdown through the shared Vite build pipeline.
- **Observability and integrations.** Public model-turn telemetry enables tracing integrations such as the new Braintrust example. This release also adds a documentation app and examples for Chat SDK, Node WebSockets, Cloudflare WebSockets, and imported skills.

### Breaking Changes

- **Applications must adopt the agent/workflow split.** Move one-shot request/result modules from `agents/` to `workflows/`; long-lived agent modules now default-export `createAgent(...)`. Workflows create invocation-local harnesses by passing runtime configuration directly to `init({ ... })`.
- **Routing and run semantics changed.** Public HTTP and WebSocket exposure is declared through `route` and `websocket` middleware exports. Runs, `/runs`, and `flue logs` now describe workflows only; direct or dispatched agent interactions correlate by instance, session, operation, and `dispatchId` instead of `runId`.
- **Roles and older agent definitions were replaced.** Migrate roles and `task({ role })` to named `defineAgentProfile(...)` subagents and `task({ agent })`; migrate reusable agent definitions to profiles and `ToolDef` imports to `ToolDefinition`.
- **Build and Cloudflare configuration changed.** Node and Cloudflare builds now use a shared Vite graph; Cloudflare development follows `.dev.vars` / `.env` and `CLOUDFLARE_ENV` conventions. Cloudflare workflows now receive per-workflow Durable Object bindings, so review generated Wrangler configuration when upgrading.
- **Cloudflare Shell is connector-owned.** Install it with `flue add @cloudflare/shell` and import its workspace sandbox helpers from the generated connector rather than `@flue/runtime/cloudflare`.

### Fixes & Other Changes

- Improved durability and retry handling for Cloudflare workflow admission and interrupted direct agent prompts, preserved authored Cloudflare environment configuration during Vite builds, and reduced Workers AI streaming parse overhead.
- Fixed model-invoked subagent task execution and expanded migrated examples and documentation for the new application model.

## 0.7.1 - 2026-05-25

### Fixes & Other Changes

- **Cloudflare agent route forwarding preserves the request body.** Flue now forwards a cloned request into Cloudflare agent routing, preventing request body consumption from making the original request unreadable after routing.

## 0.7.0 - 2026-05-15

### New Features

- **Cloudflare shell sandbox.** Added `getShellSandbox({ workspace, loader })`, `getDefaultWorkspace()`, and `hydrateFromBucket()` from `@flue/runtime/cloudflare`. The new sandbox wires `@cloudflare/shell` Workspaces into Flue through a codemode `code` tool backed by a Worker Loader binding. Agents use `state.*` inside the `code` tool instead of bash/read/write/grep/glob. Use `@cloudflare/shell` directly for primitives like `Workspace`, `WorkspaceFileSystem`, and `createGit`.

### Breaking Changes

- **`getVirtualSandbox()` now throws with a migration message.** The previous API described R2 as if it were mounted directly as the harness filesystem, but `@cloudflare/shell` Workspaces are SQLite-indexed filesystems with optional R2 blob spillover; raw bucket keys uploaded outside Workspace were invisible. Migrate bucket-backed agents to `getShellSandbox({ workspace, loader })` plus `hydrateFromBucket(workspace, env.BUCKET)` before `init()`. If you used zero-arg `getVirtualSandbox()`, remove it and omit `sandbox` from `init()` to use Flue's default in-memory sandbox.

## 0.6.2 - 2026-05-14

### Fixes & Other Changes

- **`init({ cwd })` with a relative path now resolves against the sandbox cwd.** Previously, `init({ cwd: 'relative/path' })` was treated as if absolute against the sandbox root (`'relative/path'` → `/relative/path`), so agents ran in the wrong directory — potentially discovering the wrong `AGENTS.md`, skills, or pointing shell/file operations at unintended paths. Relative `cwd` values now resolve against the parent `SessionEnv`'s `cwd`, matching the pattern already used for task sessions. Absolute paths are unchanged. Fixes #152.

- **`flue --config <path>` resolves against the caller's cwd, not `--root`.** The explicit `--config` flag was being resolved against `searchFrom` (effectively `--root`), contradicting the CLI help text and the config-module doc comment, and diverging from Vite/Astro behavior. Explicit `--config` paths now resolve against `process.cwd()`. Auto-discovery (no `--config` flag) still scans `searchFrom`, so `--root` continues to influence where the config is looked up when one wasn't named explicitly. Fixes #152.

- **`isBashLike` duck-check no longer accepts `fs: null`.** Because `typeof null === 'object'`, an object like `{ exec, getCwd, fs: null }` slipped past `assertBashLike` / `isBashLike` and crashed later inside `createBashSessionEnv` on the first `fs.readFile(...)` call instead of failing with the clear `"BashFactory must return a Bash-like object"` validation error. The check now rejects `fs: null` explicitly, and the predicate is shared between `sandbox.ts` and `client.ts` so the two copies can't drift. Fixes #149.

## 0.6.1 - 2026-05-13

### Fixes & Other Changes

- **Runtime dependencies now use the maintained `@earendil-works/*` package scope.** Replaced deprecated `@mariozechner/pi-ai` and `@mariozechner/pi-agent-core` dependencies and imports with `@earendil-works/pi-ai` and `@earendil-works/pi-agent-core`, and updated the website model registry endpoint to read from the new package scope. Fixes #143.

## 0.6.0 - 2026-05-13

### New Features

- **Compaction tuning on `init({ compaction })` and on-demand `session.compact()`.** Compaction (the mechanism that summarizes older messages when context approaches the window limit) is now configurable from agent code. `init({ compaction: { reserveTokens, keepRecentTokens, model } })` lets agents shape the headroom buffer, the verbatim tail size, and the summarization model. `init({ compaction: false })` disables threshold compaction entirely (overflow recovery still runs). `session.compact()` triggers compaction on demand for Claude-Code-style `/compact` UX — surfaces in the event stream as `compaction_start` with `reason: 'manual'` and as `operation_start` with `operationKind: 'compact'`. Throws if another operation (`prompt`/`skill`/`task`/`shell`) is in flight on the session. Fixes #135, #136.

  ```ts
  // Smaller models with tighter windows
  init({
    model: 'cloudflare/@cf/google/gemma-7b-it',
    compaction: { reserveTokens: 1024, keepRecentTokens: 2048 },
  });

  // Cheap summarizer on an expensive session model
  init({
    model: 'anthropic/claude-opus-4-5',
    compaction: { model: 'anthropic/claude-haiku-4-5' },
  });

  // Manual compact (e.g. wired to a slash command)
  await session.compact();
  ```

- **`local()` sandbox factory for host-bound agents on Node.** A new factory exported from `@flue/runtime/node`. `init({ sandbox: local() })` builds a `SessionEnv` that binds directly to the host: `exec` runs through the user's shell, file methods hit the real filesystem, and `cwd` defaults to `process.cwd()`. Env exposure is opt-in by design — only a small allowlist of shell essentials (`PATH`, `HOME`, `USER`, `LOGNAME`, `HOSTNAME`, `SHELL`, `LANG`, `LC_ALL`, `LC_CTYPE`, `TZ`, `TERM`, `TMPDIR`, `TMP`, `TEMP`) is inherited from `process.env`. Anything else, including API keys and tokens, must be passed explicitly via the `env` option, which keeps host secrets out of the agent's `bash` tool by default. Set a key to `undefined` to drop a default; pass `env: { ...process.env }` to opt into the full host env.

  ```ts
  import { local } from '@flue/runtime/node';

  init({
    sandbox: local({
      env: { GH_TOKEN: process.env.GH_TOKEN },
    }),
  });
  ```

- **Public OpenAPI spec for Flue's built-in routes.** `GET /openapi.json` now serves an OpenAPI 3.1 document for `POST /agents/<name>/<id>` and `GET /runs/<runId>{,/events,/stream}`. The spec is generated from Valibot schemas via `hono-openapi`, includes Flue's canonical error envelope, documents SSE routes with `x-flue-streaming: true`, and marks agent invocation payloads as user-defined.

- **Read-only admin API sub-app.** `admin()` is now exported from `@flue/runtime/app` and can be mounted by user apps with their own auth middleware, e.g. `app.use('/admin/*', myAuthMiddleware); app.route('/admin', admin())`. It serves `GET /openapi.json`, `GET /agents`, `GET /agents/<name>/instances`, `GET /agents/<name>/instances/<id>/runs`, `GET /runs`, and `GET /runs/<runId>` relative to the mount point. Flue ships no auth opinions; middleware order in the user's Hono app controls access.

- **SDK scaffold for public and admin APIs.** The `@flue/sdk` workspace package now contains a private, hand-written typed client scaffold for deployed Flue apps. It covers agent invocation modes, run lookup/events/streams, and read-only admin routes. The runtime still serves OpenAPI specs, but SDK code generation is deferred until a later pass can wire real spec snapshots and generated request methods end-to-end.

### Breaking Changes

- **`sandbox` magic strings removed.** `init({ sandbox })` no longer accepts the literal strings `'empty'` or `'local'`. The TypeScript union excludes both, and the runtime throws with a migration message for JS callers / `any`-typed inputs.
  - For the default in-memory sandbox, omit the `sandbox` option entirely or pass `false`.
  - For host-bound agents on Node, use the `local()` factory from `@flue/runtime/node`. It also lets you opt host env vars into the sandbox via `local({ env: { ... } })`.

  ```diff
  - init({ sandbox: 'empty', model: 'anthropic/claude-sonnet-4-6' });
  + init({ model: 'anthropic/claude-sonnet-4-6' });

  - init({ sandbox: 'local', model: 'anthropic/claude-sonnet-4-6' });
  + import { local } from '@flue/runtime/node';
  + init({ sandbox: local({ env: { GH_TOKEN: process.env.GH_TOKEN } }), model: 'anthropic/claude-sonnet-4-6' });
  ```

- **Malformed run-event query parameters now return structured 400 errors.** `GET /runs/<runId>/events` validates query params before reading run history. `limit` must be an integer in `[1, 1000]`; `after` must be a non-negative integer; `types` must be a comma-separated list of known Flue event type names. Previously malformed `limit` / `after` values were silently defaulted or ignored.

- **Run-lookup HTTP routes are now identified by `runId` alone.** The previous `GET /agents/<name>/<id>/runs/<runId>{,/events,/stream}` route family is removed and replaced with `GET /runs/<runId>{,/events,/stream}`. The new routes work end-to-end on both Node and Cloudflare for any run that exists anywhere in the deployment — the server resolves the owning `(agentName, instanceId)` via a new internal run registry, so callers no longer need to know which agent or instance ran a given run id. External consumers hitting the old paths will get a 404; update to the bare form. The `POST /agents/<name>/<id>` invocation route is unchanged.

  ```diff
  - curl http://localhost:3583/agents/hello/inst-1/runs/run_01H...
  + curl http://localhost:3583/runs/run_01H...
  ```

- **`flue logs` now takes only the run id.** The CLI signature simplifies from `flue logs <agent> <id> <runId>` to `flue logs <runId>`, matching the new route shape. The `<agent>` and `<id>` positional arguments are removed.

  ```diff
  - flue logs hello inst-1 run_01H...
  + flue logs run_01H...
  ```

- **Cloudflare deployments gain a new `FlueRegistry` Durable Object class.** Auto-injected into the generated `dist/wrangler.jsonc` as a SQLite-backed DO binding (`FLUE_REGISTRY`) and a migration entry (`flue-class-FlueRegistry`). New deployments include it in their initial migration; existing deployments upgrading get a single appended migration entry. No user action required — the build's wrangler-merge owns the injection.

- **`@flue/sdk` has been renamed to `@flue/runtime`.** The runtime library that user agent code and the generated server depend on is now published as `@flue/runtime`. User-facing agent, connector, MCP, and sandbox helper APIs now import from the root `@flue/runtime` entry; the old `@flue/sdk/client` and `@flue/sdk/sandbox` subpaths are folded into root. Platform/internal subpaths remain (`@flue/runtime/app`, `@flue/runtime/cloudflare`, `@flue/runtime/node`, `@flue/runtime/internal`). To migrate, replace user-code `@flue/sdk` imports with `@flue/runtime`. Generated `dist/` artifacts must be rebuilt — the new build emits `@flue/runtime/*` imports in `server.mjs` / `_entry.ts`.

  The transitional `@flue/runtime/client` and `@flue/runtime/sandbox` subpaths still resolve for now, but immediately throw with migration guidance. They will be removed in a later release.

  ```diff
  - import type { FlueContext } from '@flue/sdk/client';
  + import type { FlueContext } from '@flue/runtime';
  ```

- **Build tooling (`build`, `dev`, `parseEnvFiles`, `resolveEnvFiles`, `resolveSourceRoot`, the build plugins, env-file helpers) has moved from `@flue/sdk` to `@flue/cli`.** `@flue/runtime` is now a pure runtime library with no `esbuild` / `typescript` / `wrangler` baggage. The `wrangler` peer dependency moved with it and is now on `@flue/cli`. If you were driving the build programmatically via `import { build } from '@flue/sdk'`, update to import from `@flue/cli` (currently via internal paths; a stable public API will land separately).

- **`flue.config.ts` now imports `defineConfig` from `@flue/cli/config`.** Update existing configs:

  ```diff
  - import { defineConfig } from '@flue/sdk/config';
  + import { defineConfig } from '@flue/cli/config';
  ```

  This sets up the eventual collapse to `import { defineConfig } from 'flue/config'` (matching Astro/Vite). `flue init` now scaffolds the new import. The `@flue/sdk/config` subpath no longer exists.

- **The `@flue/sdk` package is now a migration placeholder.** It keeps publishing with the old export map (`.`, `./app`, `./client`, `./sandbox`, `./internal`, `./cloudflare`, `./node`, `./config`) but has no runtime dependencies and every import throws with migration guidance. This prevents old installs from silently staying on an obsolete package while reserving the name for a future client-side SDK for talking to deployed Flue applications (send agent interactions, invoke or inspect workflow runs, stream events, etc.).

### Fixes & Other Changes

- **Structured output options use `result` again.** The `schema` option on `prompt()` / `skill()` / `task()` made it unclear whether the schema described input or output, especially next to `skill({ args })`. Use `result: <schema>` for structured output going forward. The `schema` option remains accepted at runtime for backwards compatibility, but is deprecated in TypeScript and will be removed in a future release. Structured calls still return `{ data, usage, model }`; the response field alias `{ result }` remains deprecated in favor of `{ data }`.

- **Compaction defaults are now model-aware.** Previously every session used flat `reserveTokens: 16384` and `keepRecentTokens: 20000`, which were calibrated for Sonnet-class 200k windows but broke on small-window models (Gemma, Llama-3.1-8B at 8–16k windows): the reserve exceeded the window, so threshold compaction misfired on every turn, and `keepRecentTokens` exceeded the window entirely so `prepareCompaction` could never find a valid cut point. Defaults are now derived from the model's metadata: `reserveTokens = min(20_000, model.maxTokens)` capped further when it would exceed half the contextWindow, and `keepRecentTokens = 8000` (matching the convention used by OpenCode and similar agents — recent-context fidelity doesn't scale with window size). Effect on existing Sonnet/Kimi-class sessions: marginally different trigger points and a smaller verbatim tail (8k vs 20k). Effect on small-window sessions: compaction actually works.

- **`cloudflare/<model>` resolutions now carry real `contextWindow`, `maxTokens`, `cost`, `reasoning`, and `input` metadata.** Previously the binding branch of `buildModelFromRegistration` synthesized a model from scratch with `contextWindow: 0`, which made `shouldCompact` evaluate `contextTokens > 0 - reserveTokens` as true on every turn after the first — spamming `[flue:compaction] Threshold reached — window 0` and running no-op compaction prep on every turn. Resolution now hydrates from pi-ai's `cloudflare-workers-ai` catalog when the model id is known. Uncatalogued ids (embeddings, image-gen, anything outside pi-ai's chat-completion subset of Workers AI) fall back to zero metadata, and `shouldCompact` now treats `contextWindow <= 0` as unknown and skips the threshold check — overflow recovery still runs. Fixes #132.

- **`registerProvider(...)` now accepts `contextWindow`, `maxTokens`, and per-model overrides for HTTP providers.** Registered HTTP providers (litellm, openrouter, vLLM, custom OpenAI-compatible proxies, etc.) had no way to declare model metadata, so resolved models hardcoded `contextWindow: 0` and `maxTokens: 0` — same bug class as #132 on the binding side. Now the registration accepts provider-level defaults (`contextWindow`, `maxTokens`) and a `models: Record<string, { contextWindow?, maxTokens? }>` map for per-model overrides. Per-model overrides win over provider-level defaults; unset stays `0`, which `shouldCompact` treats as unknown.

  ```ts
  registerProvider('litellm', {
    api: 'openai-completions',
    baseUrl: 'http://localhost:4000/v1',
    contextWindow: 128000,
    maxTokens: 16000,
    models: {
      'gpt-4o-mini': { contextWindow: 128000, maxTokens: 16384 },
    },
  });
  ```

## 0.5.3

### New Features

- **`observe(...)` exported from `@flue/sdk/app` for isolate-global subscriptions to the Flue event stream.** Cross-cutting integrations — error reporting, log forwarding, metrics — can now tap every Flue event in the current isolate from a single module-scoped call, without per-agent or per-context wiring. The subscriber receives the fully decorated `FlueEvent` (with `runId`, `eventIndex`, `timestamp`, and tree-correlation fields) and the originating `FlueContext`. On the Cloudflare target each Durable Object is its own V8 isolate, so `app.ts` (and thus the `observe` registration) is evaluated per-DO — each isolate captures its own events independently, which is the intended shape. See `examples/sentry/` for a fully documented Sentry error-reporting integration built on top of this hook.

  ```ts
  // app.ts
  import { flue, observe } from '@flue/sdk/app';
  import * as Sentry from '@sentry/node';

  Sentry.init({ dsn: process.env.SENTRY_DSN });

  observe((event, ctx) => {
    if (event.type === 'run_end' && event.isError) {
      Sentry.captureException(event.error);
    }
  });
  ```

## 0.5.2

### New Features

- **Cloudflare AI Gateway is now enabled by default on the Cloudflare target.** Every `cloudflare/...` model call passes `gateway: { id: 'default' }` to `env.AI.run(...)`, which the Workers AI binding spins up on demand for the account. No setup required — you get caching, logs, and budget controls in the Cloudflare dashboard out of the box. Existing zero-config agents pick this up automatically on rebuild.
- **Customize or opt out of the AI Gateway from `app.ts`.** Re-register the `cloudflare` prefix with a `gateway` field to target a named gateway and tune its options (`id`, `cacheTtl`, `cacheKey`, `skipCache`, `metadata`, `collectLog`, `eventId`, `requestTimeoutMs`). Pass `gateway: false` to disable the gateway entirely. User registrations always win over the auto-registered default.

  ```ts
  // app.ts
  import { registerProvider } from '@flue/sdk/app';
  import { env } from 'cloudflare:workers';

  registerProvider('cloudflare', {
    api: 'cloudflare-ai-binding',
    binding: env.AI,
    gateway: { id: 'my-gateway', cacheTtl: 3360 },
  });
  ```

  See https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/ for the full options reference.

## 0.5.1

### Fixes & Other Changes

- **Sessions now forward a stable affinity key to pi-ai as `sessionId`.** Derived from the `(instanceId, harnessName, sessionName)` triple as `<instanceId>::<harnessName>::<sessionName>`, this key is forwarded by pi-ai to providers that support session-aware prompt caching and routing (Anthropic, OpenAI Responses, OpenAI Codex, Workers AI via `x-session-affinity`, and others). Stable across runs of the same triple, distinct across different ones. Child task sessions get their own key automatically because their session name is `task:<parent>:<taskId>`.

## 0.5.0

### Breaking Changes

- **`FlueAgent` is now `FlueHarness`.** The value returned from `init()` is a harness: a configured handle for model defaults, tools, sandbox, filesystem, and sessions. Rename imports/usages from `FlueAgent` to `FlueHarness`, and prefer `const harness = await init(...)` in agent files.
- **Harnesses and sessions are named, not id'd.** `init({ id })` is now `init({ name })`, defaulting to `"default"`. The returned harness exposes `.name` instead of `.id`. `harness.session(id?)`, `harness.sessions.get/create/delete(id?)`, and `FlueSession.id` are now name-based APIs (`name?`, `.name`).
- **Session storage keys now include the agent instance id, harness name, and session name.** Existing persisted sessions under the old two-part key shape are not migrated. Cloudflare Durable Object session history from earlier builds will not be read by this release.
- **Webhook responses return `runId` instead of `requestId`.** Every HTTP invocation now gets a generated `run_<ulid>` exposed to handlers as `ctx.runId`. Webhook mode returns `{ status: 'accepted', runId }`.
- **The event vocabulary changed for run observability.** `tool_end` is now `tool_call`, `operation_end` is now `operation`, and session correlation fields use `harness`, `session`, and `parentSession` instead of the previous id-oriented names. Consumers of the raw `FlueEvent` stream should update event-type checks and field names.
- **SSE `event: result` was removed.** Terminal result/error state is now delivered by the wide `run_end` event. Sync responses still return `{ result, _meta: { runId } }`.

### New Features

- **Run history and durable event logs.** Every invocation is recorded as a run with `run_start` / `run_end` lifecycle events and a monotonic `eventIndex`. Cloudflare persists run history in the Agent Durable Object SQLite storage; Node keeps an in-memory ring buffer of recent completed runs.
- **Run-scoped HTTP endpoints.** New read-only endpoints expose a known run: `GET /agents/<name>/<id>/runs/<runId>`, `GET /agents/<name>/<id>/runs/<runId>/events`, and `GET /agents/<name>/<id>/runs/<runId>/stream`. There is intentionally no list-runs endpoint yet; broader run discovery remains admin-API territory.
- **Reconnectable live run streams.** `/runs/<runId>/stream` replays durable history and then tails active runs. It honors standard `Last-Event-ID` resume semantics and closes when `run_end` is observed.
- **`flue logs` command.** `flue logs <agent> <id> <runId>` replays or tails a known run from a running Flue dev server. It supports `--follow` / `--no-follow`, `--since`, `--types`, `--limit`, and `--format pretty|json|ndjson`.
- **Structured handler logs.** Handlers can call `ctx.log.info(...)`, `ctx.log.warn(...)`, and `ctx.log.error(...)` to emit structured `log` events into the run event stream and persisted history.
- **`flue run` surfaces run ids.** One-shot runs now print the generated run id to stderr and include `_meta.runId` in sync responses, making it easier to inspect the same run with `flue logs`.

### Fixes & Other Changes

- **Run lifecycle ordering is durable-before-live.** Terminal `run_end` events are appended before live subscribers are notified and before the run is marked terminal, avoiding missed terminal events for clients connecting near completion.
- **Live event fan-out is ordered per run.** Durable writes are serialized before publishing each non-terminal event to live subscribers.
- **SSE streams now use a shared 15s heartbeat.** Both direct agent SSE responses and run-history streams emit heartbeats to avoid idle proxy/client timeouts.
- **Cloudflare run-route parsing is positional.** An agent instance id of `"runs"` no longer collides with the `/runs` route marker.
- **Generated docs and examples were updated for the harness terminology and new run observability APIs.**

## 0.4.1

### Fixes & Other Changes

- **`session.shell()` now redacts `env` values in transcript history.** When you pass per-call environment variables to `session.shell(cmd, { env })`, the keys still appear in the recorded tool-call arguments — so the model can reason about _which_ variables were set on a later turn — but the values are replaced with `<redacted>`. The real values are still passed to `env.exec()`, so the command itself runs with the actual environment. This prevents API keys and other secrets from leaking into session storage.

## 0.4.0

Big release! We are working hard to stabilize our APIs and add any missing and essential features to Flue that you need. There are some breaking changes to be aware of, when upgrading from `v0.3` to `v0.4`. Read through the list below to understand what's new and what's changed. Or, point your coding agent to this changelog URL for a more automated upgrade experience).

### Breaking Changes

- **New return type for `prompt()` / `skill()` / `task()` / `shell()`.** Two changes folded into one new shape:
  1. They now return a `CallHandle<T>` instead of a `Promise<T>`. `await` works exactly as before. The handle is a `PromiseLike` with `.signal: AbortSignal` and `.abort(reason?)` for synchronous cancellation, replacing the removed `PromptOptions.timeout` / `SkillOptions.timeout` / `ShellOptions.timeout` fields. Code that uses these as plain Promises without `await` (e.g. raw `.then()` / `.catch()` chains) may need adjustment.

  ```ts
  // Cancel via an AbortSignal on the options bag
  const result = await session.prompt('…', { signal: AbortSignal.timeout(5000) });

  // Or abort the handle directly
  const handle = session.prompt('…');
  setTimeout(() => handle.abort('user cancelled'), 5000);
  ```

  2. The awaited value is now `{ text | data, usage, model }` instead of a bare string or schema value. Schema-typed calls return `PromptResultResponse<T>`; non-schema calls return `PromptResponse` with the new `usage` and `model` fields. To migrate, read `response.text` or `response.data`:

  ```ts
  // Before
  const text = await session.prompt('…');
  const user = await session.prompt('…', { result: UserSchema });

  // After
  const { text } = await session.prompt('…');
  const { data: user } = await session.prompt('…', { result: UserSchema });
  ```

  Structured results use the `result` option and return validated data on `response.data`.

  Schema results are now extracted via injected `finish` / `give_up` model-facing tools instead of `---RESULT_START---` / `---RESULT_END---` text markers. The unused `ResultExtractionError` class is removed; a new `ResultUnavailableError` is thrown when the model invokes `give_up`.

- **`commands` and `defineCommand` are removed.** The original idea — register first-party CLI tools the agent could shell out to — only worked under just-bash and saw little real use. The same surface is better expressed today by passing `env` to scope what a connector sees, or by choosing a sandbox connector that gives you the isolation you want. just-bash itself still supports custom commands — you just register them on your bash instance directly instead of through Flue's helper. Removed: the `commands?:` option on `init()` / `prompt()` / `skill()` / `task()` / `shell()`; the `Command`, `CommandDef`, `CommandOptions`, `CommandExecutor`, `CommandExecutorResult` types; the `defineCommand` export from `@flue/sdk/node` and `@flue/sdk/cloudflare`; the `command_start` / `command_end` `FlueEvent` variants; and the `BashLike.registerCommand` / `SessionEnv.scope` connector hooks.

- **Default `thinkingLevel` changed from `'off'` to `'medium'`.** Reasoning-capable models (e.g. gpt-5, claude-opus-4-7) will now reason by default on every `prompt()` / `skill()` / `task()` call. Non-reasoning models are unaffected (clamped to `'off'` per the model's `thinkingLevelMap`). To restore the old behavior, set `thinkingLevel: 'off'` explicitly on `init()`, your role frontmatter, or the call options.

- **`sandbox: 'local'` now runs locally.** Originally, `'local'` was a half-isolated layer — a `just-bash` subprocess with a `ReadWriteFs` / `MountableFs` overlay mounting `process.cwd()` at `/workspace`. That made sense when every Flue agent ran on a developer laptop, but increasingly people are deploying the agent itself _inside_ a real sandbox (a container, a microVM, a Cloudflare Sandbox), where wrapping the host in a second virtual filesystem is pure overhead — and actively confusing, because paths get remapped twice. `sandbox: 'local'` now binds directly to the host: `exec` runs through the user's shell with full `process.env`, file methods hit the real filesystem, default `cwd` is `process.cwd()`, and there are no path remappings or command restrictions. Agents that hard-coded `/workspace` paths must migrate to real host paths. If you want isolation on a developer laptop, reach for a real sandbox connector (Daytona, E2B, Mirage, etc.).

- **`commands` / `defineCommand` removed.** The `commands` API let you register user CLIs (`gh`, `npm`, etc.) into a sandbox-scoped `$PATH`, isolating secrets from the model. In practice it only ever worked when the sandbox was a `BashFactory` (the default in-memory sandbox or `getVirtualSandbox` on Cloudflare), and threw a runtime error on `'local'`, every remote connector (Daytona, E2B, Mirage, etc.), and Cloudflare Containers — so the documented "CI agent with `defineCommand('gh', { env: { GH_TOKEN } })`" pattern has been broken for most users since `'local'` was rebuilt. We're collapsing the API:
  - With the new `'local'` sandbox, the host shell is exposed directly. The agent's `bash` tool can run `gh issue view`, `npm test`, etc. with whatever's on `$PATH` and whatever env you launched flue with. The runner / container / VM is the isolation boundary.
  - For non-`'local'` sandboxes, install the binaries inside the sandbox image, or wrap the operation as a custom tool with `init({ tools: [...] })`. Tools have a structured parameter schema, are visible to the model directly, and recover the "secrets stay on the host" property — the tool reads `process.env`, the agent only sees the tool's params and result.

  Removed: `Command`, `CommandDef`, `CommandOptions`, `CommandExecutor`, `CommandExecutorResult` types; `defineCommand` from `@flue/sdk/node` and `@flue/sdk/cloudflare`; `commands?:` field on `init()`, `prompt()`, `skill()`, `task()`, `shell()`; `BashLike.registerCommand?`, `SessionEnv.scope?`; the dead `command_start` / `command_end` `FlueEvent` variants.

- **`init({ providers: { … } })` has moved.** Provider configuration moved to the new `app.ts` runtime registration model (see below). Migrate by creating an `app.ts` at your project root and calling `configureProvider()` (to patch a built-in catalog provider's `baseUrl` / `apiKey` / `headers` / `storeResponses`) or `registerProvider()` (to register a brand-new URL-prefix provider). Both are exported from `@flue/sdk/app`. The `ProvidersConfig` type and `providers` field are removed from `AgentInit` and `AgentConfig`.

- **`FlueAgent.destroy()` and `SessionEnv.cleanup()` are removed.** Flue no longer manages sandbox lifetime — sandboxes are user-owned. Connectors that previously took a `cleanup` option (Boxd, Daytona, E2B, Exedev, islo, Modal, Vercel) no longer accept it; some lose their options argument entirely (e.g. `daytona(sandbox)` instead of `daytona(sandbox, { cleanup })`). If you were relying on automatic teardown, destroy your sandbox explicitly when your handler is done.

- **CLI `--workspace` flag renamed to `--root`** across `flue dev` / `flue run` / `flue build`. The corresponding programmatic options also moved: `BuildOptions.workspaceDir` → `BuildOptions.root`, `BuildContext.workspaceDir` → `BuildContext.root`. The `flue.config.ts` key is `root`, not `workspace`.

- **`outputDir` renamed to `output`** across `BuildOptions`, `BuildContext`, and `DevOptions`. Build plugin authors reading `ctx.outputDir` must update to `ctx.output`. The CLI flag remains `--output`. The default is `<root>/dist`, and `--output` is now the literal output directory (previously it was a parent directory into which `dist/` was written). `BuildOptions.output` is now optional.

- **Built-in `/health` and `/agents` HTTP endpoints removed.** Projects that need them must author the routes in `app.ts`. `flue dev` and `flue run` no longer probe `/health`; `flue run` retries SSE POST on `ECONNREFUSED` for ~5s instead.

- **`Skill.instructions` field removed from the public type.** Skill bodies are no longer cached in memory — at call time the model reads `SKILL.md` from disk via its filesystem tools. This means relative references inside a skill resolve correctly, and edits are picked up mid-session without re-init. If you were reading `skill.instructions` from the SDK types, read the file from disk yourself.

- **Sandbox connector contract: `SandboxApi.exec` is now timeout-primary, signal-optional.** Connectors are expected to forward `timeout` to their provider's native timeout option (E2B `timeoutMs`, Daytona `timeout`, etc.); signal-aware SDKs may additionally forward `signal` for true mid-flight cancellation. `BashLike.exec` options gained `signal?: AbortSignal`. If you maintain a sandbox connector, see [Sandbox Connector API](https://flueframework.com/docs/api/sandbox-api/) for the dual contract.

- **Long-running agents on Node no longer time out at ~300s.** The generated Node server now sets `requestTimeout: 0` on the underlying `http.Server` and emits a 25s SSE heartbeat, which keeps undici's `bodyTimeout` and reverse-proxy idle timers satisfied. Multi-minute `bash` calls and other long handlers that emit no Flue-level events for >300s no longer abort with `[flue] Agent error: terminated`.

### New Features

- **`flue.config.ts` project config.** A `flue.config.{ts,mts,mjs,js,cjs,cts}` file at the project root is auto-discovered and can set `target` (`'node' | 'cloudflare'`), `root`, and `output`. CLI flags still win per-field. Authored in TypeScript via Node's native type-stripping (no bundling). New `--config <path>` flag on `flue dev` / `flue run` / `flue build`. New `@flue/sdk/config` subpath export with `defineConfig`, `resolveConfig`, `resolveConfigPath`, `UserFlueConfig`, `FlueConfig`, `ResolveConfigOptions`, `ResolvedConfigResult`.

  ```ts
  // flue.config.ts
  import { defineConfig } from '@flue/sdk/config';

  export default defineConfig({
    target: 'cloudflare',
  });
  ```

- **`flue init` command** scaffolds a starter `flue.config.ts` in the target directory. Flags: `--target <node|cloudflare>` (required), `--root <path>`, `--force` (overwrite existing).

- **`app.ts` runtime entry point.** A new optional `app.ts` (also `.mts` / `.js` / `.mjs`) at the source root lets you take over the request pipeline with custom Hono middleware, routes, auth, etc. Mount Flue's agent handler via `app.route('/', flue())`. New `@flue/sdk/app` subpath export ships:
  - `flue()` — Hono sub-app exposing `/agents/:name/:id`.
  - `Fetchable` — type for the user app's default export.
  - `registerProvider(name, def)` — register a new URL-prefix model provider at runtime, with platform `env` in scope. Supports HTTP and Cloudflare AI binding registrations (`HttpProviderRegistration`, `CloudflareAIBindingRegistration`, `CloudflareAIBinding`).
  - `registerApiProvider` — re-exported from pi-ai for entirely new wire protocols.
  - `configureProvider(slug, settings)` — patch `baseUrl` / `apiKey` / `headers` / `storeResponses` on an existing pi-ai catalog provider or previously registered prefix.

- **`.flue/`-as-source layout.** When `<root>/.flue/` exists, source files (`agents/`, `roles/`, optional `app.ts`) are read from there; otherwise from `<root>/` directly. `.flue/` wins unconditionally if present.

- **AbortSignal cancellation across `prompt()` / `skill()` / `task()` / `shell()`.** Pass `signal: AbortSignal` (e.g. `AbortSignal.timeout(5000)`) on the options bag, or use the new `CallHandle.abort(reason?)` method on the returned handle. Aborts reject with a standard `DOMException` named `AbortError` whose `cause` is the signal's reason. Aborting a `prompt()` also tears down in-flight `bash` tool commands, not just the model loop. `SessionEnv.exec()` also accepts `signal?` alongside `timeout?`.

- **Per-call reasoning effort.** New `thinkingLevel?: ThinkingLevel` on `AgentInit`, `Role` (also via role frontmatter `thinkingLevel:`), `PromptOptions`, `SkillOptions`, `TaskOptions`, and `AgentConfig`. Precedence: per-call > role > agent. Tasks inherit the parent's resolved level. Per-call `'off'` is rejected (init/role/agent-level only). Unknown values in role frontmatter throw at build time. `ThinkingLevel` re-exported from `@flue/sdk` and `@flue/sdk/client`. A single deployment can now serve a cheap classifier at `'low'` and a careful auditor at `'high'` from the same model entry.

- **Images on `prompt()` / `skill()` / `task()`.** New `images?: PromptImage[]` option on all three (and the initial turn of `task()`). `PromptImage` is the shape `{ type: 'image', data: base64, mimeType }`, re-exported from pi-ai. Requires a vision-capable model. For schema-result calls, images are attached on the first attempt only; retries are text-only.

- **Token + cost usage on every response.** `PromptResponse` (and the new `PromptResultResponse<T>`) now include `usage: PromptUsage` and `model: PromptModel`. `PromptUsage` aggregates across every LLM call dispatched by a single invocation — assistant turns, schema-result retries, the 1–2 compaction summarization calls, and the post-compaction overflow retry. Fields: `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, plus a `cost` breakdown (`input`, `output`, `cacheRead`, `cacheWrite`, `total`). `PromptModel.id` reflects the model Flue selected via call > role > agent precedence.

- **Thinking events on the SSE stream.** Three new `FlueEvent` variants: `thinking_start`, `thinking_delta` (with `delta: string`), and `thinking_end` (with `content: string`). `flue run` renders them as dimmed lines under a `thinking:start` marker.

- **`fs` surface on `FlueAgent` and `FlueSession`.** Out-of-band sandbox filesystem access that doesn't appear in the conversation transcript — useful for staging inputs and reading back outputs around a `prompt()` call. Methods: `readFile`, `readFileBuffer`, `writeFile` (string or `Uint8Array`), `stat`, `readdir`, `exists`, `mkdir({ recursive? })`, `rm({ recursive?, force? })`. Paths resolve relative to the agent's `cwd`.

- **`ctx.req: Request | undefined` on `FlueContext`.** Standard Fetch `Request` for the current invocation — read headers (`req.headers.get('authorization')`), method, URL, and the raw body via `req.text()` / `req.json()` / `req.arrayBuffer()` / `req.formData()`. Body is preserved for handlers (Flue's internal JSON parser consumes a clone), so HMAC signature verification over raw bytes works directly without `req.clone()`. Undefined when an agent is invoked outside an HTTP context.

- **Cloudflare Workers AI binding provider.** Models prefixed `cloudflare/<model-id>` route through `env.AI.run()` on the Cloudflare target with no API tokens — the only setup is `"ai": { "binding": "AI" }` in `wrangler.jsonc`. Works across role models, sub-tasks, and compaction. Hard error on `--target node` pointing users at pi-ai's URL-based providers.

- **`ProviderConfiguration.storeResponses?: boolean`** opt-in. When enabled, sets `store: true` on outgoing requests for `openai-responses` and `azure-openai-responses`, enabling multi-turn against reasoning models when `thinkingLevel: 'off'` is explicitly set. (Codex Responses intentionally excluded — it rejects `store: true`.)

- **`session.shell()` is now a first-class transcript citizen.** It emits the same `tool_start` / `tool_end` events as an LLM-issued `bash` call (shared `toolCallId`, `toolName: 'bash'`) and appends a user / assistant tool-use / toolResult triple to history. Per-call `cwd` and `env` overrides are preserved in the synthetic tool-call `arguments` so they remain visible to the model on subsequent turns. Aborted commands now produce a `toolResult` with `isError: true` and the error message as text (previously dropped silently).

- **Skills are now read from disk on demand.** `session.skill()` references the skill by name and the system prompt's "Available Skills" registry tells the model where to find it (`.agents/skills/<name>/SKILL.md`). Relative references inside a skill (sibling markdown files, scripts) now resolve from where they live, and edits to `SKILL.md` are picked up mid-session without re-init. Path-based references produce a distinct prompt naming the file path explicitly.

- **`createLocalSessionEnv()` helper** exported from `@flue/sdk/node`. A pure-Node `SessionEnv` backed directly by `node:fs/promises` and `node:child_process`. Configurable `cwd` via `LocalSessionEnvOptions`. `exec` honors `timeout` + `signal` and lifts the default output buffer cap to 64 MB. This is what powers the new `sandbox: 'local'` behavior.
