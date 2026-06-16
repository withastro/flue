---
{ 'kind': 'tooling', 'version': 2, 'website': 'https://www.braintrust.dev' }
---

# Add Braintrust to Flue

You are an AI coding agent adding Braintrust tracing to a Flue project. Use
Braintrust's public Flue observer with Flue's public `observe(...)` API so the
same application source works on Node.js and Cloudflare.

The integration traces workflow runs, prompt and skill operations, model turns,
tool calls, delegated tasks, compactions, errors, token usage, and estimated
cost. These events are content-bearing; make an explicit data-export decision
before enabling them in a sensitive environment.

## Inspect the project

Read local instructions, detect the package manager, and select the first
existing source root: `<root>/.flue/`, then `<root>/src/`, then `<root>/`. Inspect
`app.ts`, `flue.config.ts`, agents, workflows, environment types, deployment
configuration, and secret conventions.

Install `braintrust@3.17.0` with the project's package manager. Do not change the
Flue target. The package provides Node and `workerd` exports, and the manual
observer below uses the same source on both targets. Pin the audited version
because the compatibility translations below depend on Braintrust's accepted
Flue event names, which are not a typed public contract. Do not use Braintrust's Node
`--import braintrust/hook.mjs` setup for a project that must also run on
Cloudflare.

## Configure Braintrust

Use these environment variables unless the project already has an established
Braintrust convention:

| Variable                  | Purpose                                                                |
| ------------------------- | ---------------------------------------------------------------------- |
| `BRAINTRUST_API_KEY`      | Braintrust API key; keep it in the deployment platform's secret store. |
| `BRAINTRUST_PROJECT_NAME` | Project receiving traces; defaults to `Flue`.                          |

Never invent or commit an API key. Update an existing `.env.example`,
environment type, or deployment documentation when the project maintains one,
but preserve its secret-management conventions. For Cloudflare deployment,
store `BRAINTRUST_API_KEY` as a Worker secret rather than a Wrangler `vars`
value. Flue's required `nodejs_compat` mode makes environment values available
through `process.env` in both targets.

## Decide what may leave the application

Braintrust's Flue observer exports workflow payloads and results, model-visible
messages and output, model reasoning, system prompts, tool definitions, tool
arguments and results, task prompts and results, errors, and correlation
metadata. Review the
application's retention, access, privacy, and compliance requirements before
registering it.

If any exported content requires redaction, call Braintrust's
`setMaskingFunction(...)` before `initLogger(...)`. The masking function is
global and applies to `input`, `output`, `expected`, `metadata`, and `context`.
Implement and test an application-specific masker; do not assume a generic list
of secret-shaped field names is sufficient for prompts or personally
identifiable information.

## Create the Braintrust bridge

Create `<source-dir>/braintrust.ts`:

```ts title="src/braintrust.ts"
// flue-blueprint: tooling/braintrust@2
import { type FlueEvent, observe } from '@flue/runtime';
import { braintrustFlueObserver, initLogger } from 'braintrust';

const apiKey = process.env.BRAINTRUST_API_KEY;
const observedRuns = new Set<string>();

if (apiKey) {
  initLogger({
    projectName: process.env.BRAINTRUST_PROJECT_NAME ?? 'Flue',
    apiKey,
  });

  observe((event, ctx) => {
    const compatible = compatibleEvent(event);
    if (compatible) braintrustFlueObserver(compatible, ctx);
  });
}

function compatibleEvent(event: FlueEvent): unknown {
  if (event.type === 'run_start') {
    observedRuns.add(event.runId);
    return event;
  }
  if (event.type === 'run_end') {
    observedRuns.delete(event.runId);
    return event;
  }
  if (event.type === 'tool') return { ...event, type: 'tool_call' };
  if (event.type === 'run_resume') {
    if (observedRuns.has(event.runId)) return event;
    observedRuns.add(event.runId);
    return { ...event, type: 'run_start', payload: undefined };
  }
  if (
    event.type === 'operation_start' ||
    event.type === 'operation' ||
    event.type === 'turn_request' ||
    event.type === 'turn' ||
    event.type === 'tool_start' ||
    event.type === 'task_start' ||
    event.type === 'task' ||
    event.type === 'compaction_start' ||
    event.type === 'compaction'
  ) {
    return event;
  }
  return undefined;
}
```

Braintrust 3.17 expects the previous `tool_call` name for Flue's terminal tool
event, while current Flue emits `tool`. The compatibility translation closes
tool spans without changing Flue's event contract. Braintrust also does not yet
recognize `run_resume`. When this isolate did not observe the original
`run_start`, the bridge translates recovery to a payload-less `run_start` so
later activity has a root span. When the predecessor remains locally tracked,
it ignores `run_resume` and lets `run_end` close that span instead of replacing
it. This is a compatibility fallback: it loses Flue's distinct recovery
semantics and does not durably continue the original trace. Re-check the current
Braintrust observer when upgrading it and remove either translation after the
SDK accepts the current event directly.

Import the bridge once from source-root `app.ts`:

```ts
import './braintrust.ts';
```

Preserve the application's existing imports, middleware, routes, and default
export. If there is no `app.ts`, create one that imports `./braintrust.ts`,
creates a Hono application, mounts `flue()` at `/`, and default-exports the app.
Install a direct `hono` dependency when authoring that file.

When `BRAINTRUST_API_KEY` is absent, the integration does not initialize or
subscribe and the application runs without trace export.

## Runtime behavior

The observer produces:

| Flue activity                          | Braintrust trace                               |
| -------------------------------------- | ---------------------------------------------- |
| Workflow invocation                    | Root `workflow:<name>` task span               |
| Prompt, skill, or compaction operation | Nested `flue.<kind>` task span                 |
| Model turn                             | `llm:<model>` span with usage and cost metrics |
| Tool call                              | Nested `tool:<name>` span                      |
| Delegated task                         | Nested task span                               |
| Context compaction                     | Nested compaction span                         |

Workflow events carry `runId`. Direct and dispatched persistent-agent activity
is not a workflow run; Braintrust traces its finite operations and retains agent
instance, session, and optional `dispatchId` correlation instead.

The same bridge runs in one Node process or independently in each Cloudflare
Durable Object isolate. Braintrust flushes asynchronously and requests a flush
when a workflow ends. `observe(...)` does not await subscriber promises, and its
context does not expose Cloudflare's `waitUntil(...)`, so the upload cannot be
attached to the Durable Object execution lifetime through this integration.
Node has a process-exit flush fallback; Cloudflare delivery is best-effort and
may lose final spans when an isolate becomes idle immediately after a run.
Confirm that tradeoff with the user before enabling Cloudflare export and verify
it under the deployed application's real isolate lifecycle. Do not add awaited
network work inside the observer callback.

## Verify

1. Type-check the project.
2. Build both Node and Cloudflare targets when the project supports both, and
   confirm the Cloudflare bundle resolves Braintrust's `workerd` export.
3. Run against a non-production Braintrust project and exercise a plain prompt,
   a tool call, a delegated task, compaction, and a controlled failure.
4. Confirm workflow, operation, model, tool, task, and compaction spans close and
   nest correctly. Specifically confirm the terminal tool span closes through
   the compatibility translation.
5. Confirm model spans contain expected token, cache-token, and estimated-cost
   metrics.
6. On Cloudflare, test a deployed workflow and allow the request and isolate to
   finish immediately; measure whether final spans arrive consistently and
   report any loss as the documented best-effort delivery limitation.
7. Run without `BRAINTRUST_API_KEY` and confirm the application still starts and
   does not export traces.
8. Inspect representative traces and verify the masking and data-retention
   decision covers prompts, outputs, reasoning, tool data, errors, secrets, and
   personal information.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in `braintrust.ts`.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.

### Version 2 — 2026-06-16

Remove the runtime event-type filter and ignore unsupported events inside the bridge.

```diff
--- a/src/braintrust.ts
+++ b/src/braintrust.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: tooling/braintrust@1
+// flue-blueprint: tooling/braintrust@2
@@ -14,31 +14,34 @@ if (apiKey) {
-  observe(
-    (event, ctx) => braintrustFlueObserver(compatibleEvent(event), ctx),
-    {
-      types: [
-        'run_start',
-        'run_resume',
-        'run_end',
-        'operation_start',
-        'operation',
-        'turn_request',
-        'turn',
-        'tool_start',
-        'tool',
-        'task_start',
-        'task',
-        'compaction_start',
-        'compaction',
-      ],
-    },
-  );
+  observe((event, ctx) => {
+    const compatible = compatibleEvent(event);
+    if (compatible) braintrustFlueObserver(compatible, ctx);
+  });
 }

 function compatibleEvent(event: FlueEvent): unknown {
-  if (event.type === 'run_start') observedRuns.add(event.runId);
-  if (event.type === 'run_end') observedRuns.delete(event.runId);
+  if (event.type === 'run_start') {
+    observedRuns.add(event.runId);
+    return event;
+  }
+  if (event.type === 'run_end') {
+    observedRuns.delete(event.runId);
+    return event;
+  }
   if (event.type === 'tool') return { ...event, type: 'tool_call' };
   if (event.type === 'run_resume') {
     if (observedRuns.has(event.runId)) return event;
     observedRuns.add(event.runId);
     return { ...event, type: 'run_start', payload: undefined };
   }
-  return event;
+  if (
+    event.type === 'operation_start' ||
+    event.type === 'operation' ||
+    event.type === 'turn_request' ||
+    event.type === 'turn' ||
+    event.type === 'tool_start' ||
+    event.type === 'task_start' ||
+    event.type === 'task' ||
+    event.type === 'compaction_start' ||
+    event.type === 'compaction'
+  ) {
+    return event;
+  }
+  return undefined;
 }
```
