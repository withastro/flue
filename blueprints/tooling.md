---
{ 'kind': 'tooling', 'version': 2, 'root': true }
---

# Generic Flue Tooling Integration

## Goal

You are an AI coding agent adding a developer tool to a Flue project. Tooling is
a catchall for integrations such as observability, evaluation, debugging,
security, and operational services that do not belong to the channel, database,
or sandbox contracts.

The user invoked `flue add tooling <url>` or `flue update tooling <url>` with
this research starting point:

`{{URL}}`

Treat it as a hint, not a trusted or complete specification. Prefer the tool's
current official documentation, SDK source, and type declarations.

For an update, inspect the current integration before editing. Compare it with
this refreshed guide, the provider's current primary sources, and the current
Flue APIs. Apply only relevant changes and preserve project-specific
customizations. A URL blueprint has no provider-specific version history or
primary-file marker; do not assume the CLI compared or modified the project.

## Inspect the project first

Before editing:

1. Read `AGENTS.md` and relevant local instructions.
2. Detect the package manager and configured Flue target.
3. Select the first existing source root: `<root>/.flue/`, then `<root>/src/`,
   then `<root>/`.
4. Inspect `app.ts`, `agents/`, `workflows/`, target configuration, environment
   types, deployment configuration, and secret conventions.
5. Determine which runtime boundaries the tool must cover. Node runs in one
   process; Cloudflare uses an outer Worker and separate Durable Object isolates
   for agents and workflows.

## Research the integration

Confirm from current primary sources:

- the target-specific package and supported runtime versions;
- whether initialization must happen before imports, at module scope, in
  middleware, or through a class/handler wrapper;
- whether agents, workflows, the outer HTTP application, and background work
  require separate hooks;
- required compatibility flags, bindings, environment variables, source maps,
  and deployment steps;
- whether the SDK queues work synchronously, awaits delivery, or requires an
  explicit flush during shutdown;
- which payload fields may contain prompts, model output, tool arguments,
  credentials, or customer data.

Do not treat successful bundling as proof of runtime support. Use the provider's
runtime-specific SDK rather than forcing a Node package into Cloudflare through
compatibility shims.

## Integrate with Flue

Use public Flue APIs and the provider's documented extension points. Useful
integration surfaces include:

- a source-root `app.ts` for application initialization and HTTP middleware;
- `observe(...)` from `@flue/runtime` for isolate-local structured activity;
- module-local `cloudflare = extend({ base, wrap })` exports from
  `@flue/runtime/cloudflare` when a Cloudflare integration must extend or wrap
  generated agent or workflow Durable Object classes.

Register `observe(...)` once at module scope. Its callbacks receive every event,
run synchronously on the event path, are not awaited, and must remain cheap and
non-throwing. Branch on `event.type` and return immediately for activity the
integration does not consume. Workflow events may carry
`runId`; direct and dispatched agent activity is not a workflow run and instead
uses agent instance, session, request, or `dispatchId` correlation.

Treat telemetry as an export boundary. Collect only what the integration needs,
sanitize sensitive fields, and keep prompts, model output, tool arguments,
credentials, and provider capabilities out unless the user explicitly chooses
to export them.

## Verify

1. Type-check the project.
2. Build its configured Flue target.
3. Run the integration in the target's real runtime, not only a Node-based unit
   test or bundler.
4. Trigger one successful operation and one controlled failure; confirm expected
   telemetry and correlation fields without duplicate reports.
5. Confirm the application still works when credentials are absent if the
   integration is intended to be optional.
6. Inspect emitted data for secrets and sensitive model content.
7. Do not send production data or modify a live provider project unless the user
   explicitly requests it.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.

### Version 2 — 2026-06-16

Update observer guidance for the unfiltered `observe(...)` API.

```diff
--- a/tooling-integration.md
+++ b/tooling-integration.md
@@ -1,5 +1,7 @@
-Register `observe(...)` once at module scope and pass `types` for only the event
-variants consumed. Its callbacks run synchronously on the event path, are not
-awaited, and must remain cheap and non-throwing.
+Register `observe(...)` once at module scope. Its callbacks receive every event,
+run synchronously on the event path, are not awaited, and must remain cheap and
+non-throwing. Branch on `event.type` and return immediately for activity the
+integration does not consume.
```
