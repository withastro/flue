---
{ "kind": "tooling", "version": 3, "website": "https://sentry.io" }
---

# Add Sentry to Flue

You are an AI coding agent adding Sentry observability to a Flue project. Use
the SDK for the configured target, initialize it at the correct runtime
boundary, and connect Flue's event stream and OpenTelemetry instrumentation to
Sentry: errors as issues, `log.*` calls as Sentry Logs, and — when tracing is
enabled — the `invoke_agent` → `chat` / `execute_tool` span hierarchy with
token usage, following the OpenTelemetry GenAI semantic conventions. A
conversation's spans, logs, and issues share one trace.

Issues are limited to terminal failures: a failed top-level agent operation or
a failed durable submission settlement. Recovered errors an agent logs and
moves past arrive in Sentry Logs, not as issues. Model and tool content
(prompts, completions, tool arguments and results) stays out of traces unless
the user explicitly enables the record flags below.

## Inspect the project

Read local instructions, detect the package manager, and select the first
existing source root: `<root>/.flue/`, then `<root>/src/`, then `<root>/`. Inspect
`flue.config.ts`, `vite.config.ts`, deployment commands, `app.ts`, every module
under `agents/`, environment types, and secret conventions.

Install `@flue/opentelemetry` (matching the project's Flue version) and
`@opentelemetry/api@^1.9.0`, then determine the configured target before
installing a Sentry package:

- **Node:** install `@sentry/node@^10.64.0`.
- **Cloudflare:** install `@sentry/cloudflare@^10.64.0`. Do not use
  `@sentry/node` on Cloudflare.

If the target cannot be determined, ask the user. Do not install both SDKs to
make one static source file target-agnostic.

## Configure Sentry

Use these environment variables unless the project already has an established
Sentry convention:

| Variable                   | Purpose                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------- |
| `SENTRY_DSN`               | Project DSN; keep it configurable through the deployment environment.                                  |
| `SENTRY_ENVIRONMENT`       | Optional environment name such as `production` or `staging`.                                           |
| `SENTRY_RELEASE`           | Optional release identifier such as a commit SHA.                                                       |
| `SENTRY_TRACES_SAMPLE_RATE`| `0` to `1`. `0` (default) sends errors and logs only; above `0` also sends the Flue span hierarchy.     |
| `SENTRY_AI_RECORD_INPUTS`  | `true` to include prompts, system instructions, and tool definitions/arguments in trace spans.          |
| `SENTRY_AI_RECORD_OUTPUTS` | `true` to include model output, tool results, and exception messages/stacks in trace spans.             |

Never invent a DSN or hard-code it in application source. A Sentry DSN permits
event submission but does not grant read access to project data. Update an
existing `.env.example`, environment type, or deployment documentation when the
project maintains one, and preserve its deployment-configuration conventions.
For selective production sampling, Sentry's `tracesSampler` option can replace
the flat rate; do not add it unless the user asks.

## Decide what may leave the application

Timing, token usage, model identifiers, error types, and `flue.*` correlation
ids always flow. Everything else is policy:

- With both record flags `false` (the default), the integration passes
  `content: false` to Flue's OpenTelemetry instrumentation and no model or
  tool content reaches Sentry at all.
- With either flag on, content passes a `transform` that admits only the
  enabled direction, redacts values under sensitive keys (`scrub` below), and
  tightens the adapter's built-in 56 KiB per-attribute budget to 16 KiB via
  `truncateContent`.
- Log attributes forwarded to Sentry Logs pass the same `scrub` redaction.

Review the `SENSITIVE_KEY` pattern against the application's own secret naming
and extend it when the project handles regulated or user-identifying data.

## Create the Flue integration

Create `<source-dir>/sentry.ts` for the configured target. Both variants share
the same bridge and helpers; they differ in how the Sentry SDK initializes.

### Node

```ts title="src/sentry.ts"
// flue-blueprint: tooling/sentry@3

import {
  type ContentOption,
  createOpenTelemetryInstrumentation,
  type GenAIContentType,
  truncateContent,
} from '@flue/opentelemetry';
import { type FlueObservation, instrument } from '@flue/runtime';
import * as Sentry from '@sentry/node';

const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';
const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);

// Sentry ships integrations that patch AI provider SDKs directly. Flue's
// instrumentation already emits one `chat` span per model turn, so those
// integrations would double-count every model call.
const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
  'Anthropic_AI',
  'OpenAI',
  'Google_GenAI',
  'LangChain',
  'LangGraph',
  'VercelAI',
]);

Sentry.init({
  dsn: process.env.SENTRY_DSN,
  enabled: Boolean(process.env.SENTRY_DSN),
  environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
  release: process.env.SENTRY_RELEASE,
  tracesSampleRate,
  // Stream spans to Sentry as each one finishes, so gen_ai children that
  // complete after their parent span are not lost.
  traceLifecycle: 'stream',
  streamGenAiSpans: true,
  enableLogs: true,
  integrations: (defaults) =>
    defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
});

// `Sentry.init` registered Sentry as the global OTel tracer provider, so
// Flue's spans flow to Sentry without further wiring. Content capture is
// on by default in the adapter; `contentPolicy()` narrows it to what the
// record flags allow. The instrumentation is keyed, so a dev reload
// replaces the previous registration instead of stacking a duplicate.
if (tracesSampleRate > 0) {
  instrument(createOpenTelemetryInstrumentation({ content: contentPolicy() }));
}

// A failed submission emits a rich `operation` failure first (the original
// error, with the throw-site stack on the live `errorInfo`) and then a
// `submission_settled` whose durable `error` collapses non-Flue causes to a
// generic internal-error payload. Capture the operation and remember its
// submissionId so the settlement is skipped; a settlement with no captured
// operation (reconciled after a crash) is captured from its own `errorInfo`.
const capturedFailedSubmissions = new Set<string>();

// Best-effort flush of buffered events (notably Sentry Logs, which the SDK
// batches) on shutdown. Never call process.exit() here — Flue's generated
// server handles SIGINT/SIGTERM, awaits its lifecycle stop, and exits with
// the correct code; this listener only flushes within that window. It is not
// a delivery guarantee: the server exits as soon as its stop resolves and
// Node does not await promises started by signal listeners, so a flush still
// in flight can be cut short. Traces and issues are sent during the run;
// only very-recently-buffered logs are at risk.
const flush = () => void Sentry.flush(2000);
if (process.env.SENTRY_DSN) {
  process.on('SIGINT', flush);
  process.on('SIGTERM', flush);
}

instrument({
  // Keyed registration: on a dev reload this module re-evaluates while the
  // runtime's registry persists, and the newest install wins — the previous
  // bridge (and its signal listeners) is disposed, so no event is ever
  // double-reported.
  key: Symbol.for('flue.sentry.bridge'),
  observe(event) {
    if (event.type === 'operation' && event.isError) {
      captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event), {
        durationMs: event.durationMs,
        operationKind: event.operationKind,
      });
      if (event.submissionId) capturedFailedSubmissions.add(event.submissionId);
      return;
    }
    if (event.type === 'submission_settled') {
      const alreadyCaptured = capturedFailedSubmissions.delete(event.submissionId);
      if (event.outcome === 'failed' && !alreadyCaptured) {
        captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event));
      }
      return;
    }
    if (event.type === 'log') {
      Sentry.logger[event.level](event.message, logAttributes(event));
    }
  },
  interceptor: (_operation, _ctx, next) => next(),
  async dispose() {
    process.off('SIGINT', flush);
    process.off('SIGTERM', flush);
    await Sentry.flush(2000);
  },
});

function captureTerminalFailure(
  error: unknown,
  tags: Record<string, string>,
  context?: Record<string, unknown>,
): void {
  Sentry.withScope((scope) => {
    scope.setTags(tags);
    scope.setLevel('error');
    if (context) scope.setContext('flue.incident', context);
    Sentry.captureException(toError(error));
  });
}

// Tag keys use the `flue.*` prefix — the same names the trace spans carry —
// so pivoting on `flue.instance.id` in Sentry's search finds every issue,
// log, and span from a single agent instance.
function correlationTags(event: FlueObservation): Record<string, string> {
  const tags: Record<string, string> = {};
  if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
  if (event.agentName) tags['flue.agent.name'] = event.agentName;
  if (event.conversationId) tags['flue.conversation.id'] = event.conversationId;
  if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
  if (event.harness) tags['flue.harness'] = event.harness;
  if (event.session) tags['flue.session'] = event.session;
  if (event.parentSession) tags['flue.parent_session'] = event.parentSession;
  if (event.operationId) tags['flue.operation.id'] = event.operationId;
  if (event.taskId) tags['flue.task.id'] = event.taskId;
  return tags;
}

type LogAttribute = string | number | boolean;

function logAttributes(event: Extract<FlueObservation, { type: 'log' }>): Record<string, LogAttribute> {
  const attributes: Record<string, LogAttribute> = {};
  for (const [key, value] of Object.entries(correlationTags(event))) attributes[key] = value;
  for (const [key, value] of Object.entries(event.attributes ?? {})) {
    const scrubbed = scrub(value);
    attributes[`flue.log.${key}`] =
      typeof scrubbed === 'string' || typeof scrubbed === 'number' || typeof scrubbed === 'boolean'
        ? scrubbed
        : stringify(scrubbed);
  }
  return attributes;
}

// The content policy for trace spans. With both record flags off, no model
// or tool content reaches Sentry at all (`content: false`). With either flag
// on, the transform admits only the enabled direction, scrubs sensitive keys,
// and tightens the adapter's default 56 KiB budget to 16 KiB per attribute.
function contentPolicy(): ContentOption {
  if (!recordInputs && !recordOutputs) return false;
  return {
    transform(content, scope) {
      if (isInputContent(scope.contentType) && !recordInputs) return undefined;
      if (isOutputContent(scope.contentType) && !recordOutputs) return undefined;
      return truncateContent(scrub(content), { maxBytes: 16_384 });
    },
  };
}

function isInputContent(contentType: GenAIContentType): boolean {
  return (
    contentType === 'input_messages' ||
    contentType === 'system_instructions' ||
    contentType === 'tool_definitions' ||
    contentType === 'tool_description' ||
    contentType === 'tool_arguments'
  );
}

function isOutputContent(contentType: GenAIContentType): boolean {
  return (
    contentType === 'output_messages' ||
    contentType === 'tool_result' ||
    contentType === 'exception_message' ||
    contentType === 'exception_stacktrace'
  );
}

const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|dsn|password|secret|token/i;

function scrub(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (depth > 8) return '[truncated]';
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => scrub(item, seen, depth + 1));
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(nested, seen, depth + 1),
    ]),
  );
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  if (value && typeof value === 'object') {
    const source = value as { name?: unknown; message?: unknown; stack?: unknown };
    const error = new Error(typeof source.message === 'string' ? source.message : stringify(value));
    if (typeof source.name === 'string') error.name = source.name;
    if (typeof source.stack === 'string') error.stack = source.stack;
    return error;
  }
  return new Error(typeof value === 'string' ? value : stringify(value));
}

function stringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function clampRate(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
}
```

This module-scoped initialization supports the captures in this blueprint.
Sentry's complete Node auto-instrumentation (HTTP, database drivers) requires
its preload hook to run before application imports; if the user wants that,
configure the production Node command with the current Sentry-recommended
preload and verify it against the built Flue server. Do not claim complete
auto-instrumentation from the late `sentry.ts` initialization alone.

### Cloudflare

Replace everything above the `captureTerminalFailure` helper with the
following; keep the helpers (`captureTerminalFailure` through `clampRate`)
identical to the Node file.

```ts title="src/sentry.ts"
// flue-blueprint: tooling/sentry@3

import {
  type ContentOption,
  createOpenTelemetryInstrumentation,
  type GenAIContentType,
  truncateContent,
} from '@flue/opentelemetry';
import { type FlueObservation, instrument } from '@flue/runtime';
import { extend } from '@flue/runtime/cloudflare';
import * as Sentry from '@sentry/cloudflare';

interface Env {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  SENTRY_RELEASE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';
// Per-isolate `env` bindings are only available inside the DO wrapper below;
// the module-scope `instrument(...)` gate reads `process.env`. Keep both
// paths going through `clampRate` so an invalid rate becomes 0 on both.
const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);

const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
  'Anthropic_AI',
  'OpenAI',
  'Google_GenAI',
  'LangChain',
  'LangGraph',
  'VercelAI',
]);

export const cloudflare = extend({
  wrap: (Final) =>
    Sentry.instrumentDurableObjectWithSentry(
      (env: Env) => ({
        dsn: env.SENTRY_DSN,
        enabled: Boolean(env.SENTRY_DSN),
        environment: env.SENTRY_ENVIRONMENT,
        release: env.SENTRY_RELEASE,
        tracesSampleRate: clampRate(env.SENTRY_TRACES_SAMPLE_RATE, 0),
        traceLifecycle: 'stream',
        streamGenAiSpans: true,
        enableLogs: true,
        integrations: (defaults) =>
          defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
      }),
      Final,
    ),
});

if (tracesSampleRate > 0) {
  instrument(createOpenTelemetryInstrumentation({ content: contentPolicy() }));
}

// See the Node variant for why failed submissions need this bookkeeping.
const capturedFailedSubmissions = new Set<string>();

instrument({
  // Keyed registration: production isolates evaluate this module once; under
  // dev reloads the newest install wins and the previous one is disposed.
  key: Symbol.for('flue.sentry.bridge'),
  observe(event) {
    if (event.type === 'operation' && event.isError) {
      captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event), {
        durationMs: event.durationMs,
        operationKind: event.operationKind,
      });
      if (event.submissionId) capturedFailedSubmissions.add(event.submissionId);
      return;
    }
    if (event.type === 'submission_settled') {
      const alreadyCaptured = capturedFailedSubmissions.delete(event.submissionId);
      if (event.outcome === 'failed' && !alreadyCaptured) {
        captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event));
      }
      return;
    }
    if (event.type === 'log') {
      Sentry.logger[event.level](event.message, logAttributes(event));
    }
  },
  interceptor: (_operation, _ctx, next) => next(),
  async dispose() {
    await Sentry.flush(2000);
  },
});
```

Do not call `Sentry.init()` on Cloudflare: the Durable Object wrapper
initializes the SDK per isolate, and `Sentry.logger` / `Sentry.captureException`
in the bridge resolve against the isolate's own client. There are no signal
listeners on Cloudflare — final flushes ride the platform's event lifecycle and
are best-effort.

### Wire the application

Import the integration once from the source-root `app.ts`:

```ts
import './sentry.ts';
```

Preserve the application's existing imports, middleware, routes, and default
export. If there is no `app.ts`, create one that imports `./sentry.ts`, creates a
Hono application, mounts each HTTP-reachable agent with
`app.route('/agents/<name>', createAgentRouter(<AgentFn>))` (from
`@flue/runtime/routing`), and default-exports the app.
Install a direct `hono` dependency when authoring that file.

`observe(...)` and `instrument(...)` are isolate-local and receive every event
from every agent the current isolate handles. Captures correlate through agent
instance, agent name, conversation, session, operation, and submission fields;
pivoting on `flue.instance.id` in Sentry's search finds every issue, log, and
span from a single conversation, and `flue.submission.id` pins down one
submission.

Capture only the terminal signals above. Do not capture lower-level failed
tool, task, turn, or compaction events; they can be recoverable and would
duplicate the selected terminal signals. Do not promote `log.error` to issues —
error-level logs arrive in Sentry Logs with their attributes and trace
correlation. Do not forward prompts, model output, tool arguments, or arbitrary
event payloads outside the content policy above.

## Wire Cloudflare Durable Objects

Skip this section for Node.

On Cloudflare each agent runs in its own Durable Object, which is its own V8
isolate, separate from the outer Worker and from every other agent. The module
graph — and therefore `sentry.ts` — is evaluated once per isolate, so the
bridge and instrumentation run independently inside every isolate and each one
reports its own activity.

The SDK, however, initializes through the Durable Object class. Re-export the
`cloudflare` extension from every module under `agents/` whose agents should
report to Sentry:

```ts
export { cloudflare } from '../sentry.ts';
```

Flue applies the extension's `wrap` to the final generated Durable Object
class for every agent exported from that module;
`Sentry.instrumentDurableObjectWithSentry` returns a prototype-preserving
constructor proxy, which is exactly what `wrap` requires. The wrapper covers
agent Durable Objects, not the outer Worker or an authored Hono application —
if the user also wants HTTP request instrumentation for `app.ts`, research and
add Sentry's current Workers or Hono middleware separately.

Configure `SENTRY_DSN` through a Worker secret or environment binding according
to the project's policy. For local Wrangler development, follow the existing
`.dev.vars` or `.env` convention. Keep the DSN outside application source so it
can be rotated or disabled without a code change. Environment, release, and
sample-rate values may be Wrangler `vars`.

## Verify

1. Type-check the project and build it with `vite build` for its configured
   Flue target.
2. Start the real target runtime with a non-production Sentry project and
   `SENTRY_TRACES_SAMPLE_RATE=1`.
3. Send a message to a tool-using agent; confirm one trace containing
   `invoke_agent <AgentName>` with `chat <model>` and `execute_tool <tool>`
   children, token usage on the `chat` span, and no model or tool content
   while both record flags are off.
4. Call `log.info(...)` and `log.error(...)` from a tool; confirm each arrives
   in Sentry Logs at its level, tagged with `flue.instance.id`, on the same
   trace as its conversation — and that no issue is raised for either.
5. Send a message to an agent that fails terminally; confirm exactly one
   Sentry issue carrying the original error name, message, and throw-site
   stack, tagged with `flue.instance.id` and `flue.submission.id` — not two
   issues (the settlement duplicate must be skipped).
6. Set both record flags `true`, repeat step 3, and confirm message and tool
   content appears with sensitive keys redacted.
7. On Cloudflare, exercise at least one wrapped agent Durable Object under
   workerd and confirm spans, logs, and an issue are delivered from that
   isolate.
8. Remove the DSN and confirm the application still starts and all Sentry
   calls are no-ops.
9. Under `vite dev`, edit `sentry.ts` to force a reload, repeat step 4, and
   confirm events are reported exactly once.

When updating an existing integration, inspect and compare it against this
complete current blueprint, apply every relevant change while preserving
customizations, and then add or update the marker in `sentry.ts`.
This comparison is required when the marker is missing.

## Upgrade Guide

### Version 1 — 2026-06-15

Initial version.

### Version 2 — 2026-06-16

Remove the runtime event-type filter. The bridge continues to branch on the event variants it handles.

```diff
--- a/src/sentry.ts
+++ b/src/sentry.ts
@@ -1,4 +1,4 @@
-// flue-blueprint: tooling/sentry@1
+// flue-blueprint: tooling/sentry@2
@@ -39,51 +39,46 @@ const runTags = new Map<string, Record<string, string>>();
-observe(
-  (event) => {
-    if (event.type === 'run_start' || event.type === 'run_resume') {
-      runTags.set(event.runId, { 'flue.workflow': event.workflowName });
-      return;
-    }
+observe((event) => {
+  if (event.type === 'run_start' || event.type === 'run_resume') {
+    runTags.set(event.runId, { 'flue.workflow': event.workflowName });
+    return;
+  }

-    const tags = correlationTags(event);
+  const tags = correlationTags(event);

-    if (event.type === 'run_end') {
-      runTags.delete(event.runId);
-      if (!event.isError) return;
-      captureException(event.error, tags, { durationMs: event.durationMs });
-      return;
-    }
+  if (event.type === 'run_end') {
+    runTags.delete(event.runId);
+    if (!event.isError) return;
+    captureException(event.error, tags, { durationMs: event.durationMs });
+    return;
+  }

-    if (event.type === 'operation' && event.isError && !event.runId) {
-      captureException(event.error, tags, {
-        durationMs: event.durationMs,
-        operationKind: event.operationKind,
-      });
-      return;
-    }
+  if (event.type === 'operation' && event.isError && !event.runId) {
+    captureException(event.error, tags, {
+      durationMs: event.durationMs,
+      operationKind: event.operationKind,
+    });
+    return;
+  }

-    if (event.type === 'submission_settled' && event.outcome === 'failed') {
-      captureException(event.error, tags);
-      return;
-    }
+  if (event.type === 'submission_settled' && event.outcome === 'failed') {
+    captureException(event.error, tags);
+    return;
+  }

-    if (event.type === 'log' && event.level === 'error') {
-      Sentry.withScope((scope) => {
-        scope.setTags(tags);
-        scope.setLevel('error');
-        if (Object.hasOwn(event.attributes ?? {}, 'error')) {
-          Sentry.captureException(toError(event.attributes?.error));
-        } else {
-          Sentry.captureMessage(event.message, 'error');
-        }
-      });
-    }
-  },
-  {
-    types: ['run_start', 'run_resume', 'run_end', 'operation', 'submission_settled', 'log'],
-  },
-);
+  if (event.type === 'log' && event.level === 'error') {
+    Sentry.withScope((scope) => {
+      scope.setTags(tags);
+      scope.setLevel('error');
+      if (Object.hasOwn(event.attributes ?? {}, 'error')) {
+        Sentry.captureException(toError(event.attributes?.error));
+      } else {
+        Sentry.captureMessage(event.message, 'error');
+      }
+    });
+  }
+});
```

### Version 3 — 2026-07-21

Extend error reporting to full observability: when `SENTRY_TRACES_SAMPLE_RATE > 0`
(default `0`), register Flue's OpenTelemetry instrumentation for the
`invoke_agent` → `chat` / `execute_tool` span hierarchy with
`traceLifecycle: 'stream'`, suppressing Sentry's own AI provider integrations;
forward every `log.*` call to Sentry Logs at its own level and stop promoting
error logs to issues, so issues remain limited to terminal failures — one per
failure, remembering each failed `operation`'s submissionId so its
`submission_settled` duplicate is skipped. Model and tool content stays out of
traces unless `SENTRY_AI_RECORD_INPUTS` / `SENTRY_AI_RECORD_OUTPUTS` opt in,
with `exception_stacktrace` gated as output content. The bridge registers as a
keyed instrumentation via `instrument(...)`, replacing the bare `observe(...)`
call, so dev reloads dispose the previous install instead of stacking
duplicates; a best-effort SIGINT/SIGTERM `Sentry.flush` covers shutdown on
Node. Remove `attachStacktrace` — issues are built from the live `errorInfo`,
which carries the throw-site stack. Drop the `flue.dispatch.id` tag (the field
no longer exists; submissions carry `submissionId` only) and add
`flue.agent.name` and `flue.conversation.id`. The diff below is the Node
`sentry.ts`; on Cloudflare, initialize the SDK through the Durable Object
wrapper instead of `Sentry.init(...)` and re-export `cloudflare` from each
agent module.

```diff
--- a/src/sentry.ts
+++ b/src/sentry.ts
@@ -1,50 +1,111 @@
-// flue-blueprint: tooling/sentry@2
-import { type FlueEvent, observe } from '@flue/runtime';
+// flue-blueprint: tooling/sentry@3
+
+import {
+  type ContentOption,
+  createOpenTelemetryInstrumentation,
+  type GenAIContentType,
+  truncateContent,
+} from '@flue/opentelemetry';
+import { type FlueObservation, instrument } from '@flue/runtime';
 import * as Sentry from '@sentry/node';
 
+const recordInputs = process.env.SENTRY_AI_RECORD_INPUTS === 'true';
+const recordOutputs = process.env.SENTRY_AI_RECORD_OUTPUTS === 'true';
+const tracesSampleRate = clampRate(process.env.SENTRY_TRACES_SAMPLE_RATE, 0);
+
+// Sentry ships integrations that patch AI provider SDKs directly. Flue's
+// instrumentation already emits one `chat` span per model turn, so those
+// integrations would double-count every model call.
+const SENTRY_AI_PROVIDER_INTEGRATIONS = new Set([
+  'Anthropic_AI',
+  'OpenAI',
+  'Google_GenAI',
+  'LangChain',
+  'LangGraph',
+  'VercelAI',
+]);
+
 Sentry.init({
   dsn: process.env.SENTRY_DSN,
   enabled: Boolean(process.env.SENTRY_DSN),
   environment: process.env.SENTRY_ENVIRONMENT ?? process.env.NODE_ENV,
   release: process.env.SENTRY_RELEASE,
-  attachStacktrace: true,
-  tracesSampleRate: 0,
+  tracesSampleRate,
+  // Stream spans to Sentry as each one finishes, so gen_ai children that
+  // complete after their parent span are not lost.
+  traceLifecycle: 'stream',
+  streamGenAiSpans: true,
+  enableLogs: true,
+  integrations: (defaults) =>
+    defaults.filter((integration) => !SENTRY_AI_PROVIDER_INTEGRATIONS.has(integration.name)),
 });
 
-observe((event) => {
-  const tags = correlationTags(event);
+// `Sentry.init` registered Sentry as the global OTel tracer provider, so
+// Flue's spans flow to Sentry without further wiring. Content capture is
+// on by default in the adapter; `contentPolicy()` narrows it to what the
+// record flags allow. The instrumentation is keyed, so a dev reload
+// replaces the previous registration instead of stacking a duplicate.
+if (tracesSampleRate > 0) {
+  instrument(createOpenTelemetryInstrumentation({ content: contentPolicy() }));
+}
 
-  // Prefer the live `errorInfo` observation detail over the event's
-  // durable-shaped `error`: only errorInfo carries the throw-site stack
-  // (durable records are deliberately stackless), so Sentry issues group
-  // on the real origin frame instead of this bridge.
-  if (event.type === 'operation' && event.isError) {
-    captureException(event.errorInfo ?? event.error, tags, {
-      durationMs: event.durationMs,
-      operationKind: event.operationKind,
-    });
-    return;
-  }
+// A failed submission emits a rich `operation` failure first (the original
+// error, with the throw-site stack on the live `errorInfo`) and then a
+// `submission_settled` whose durable `error` collapses non-Flue causes to a
+// generic internal-error payload. Capture the operation and remember its
+// submissionId so the settlement is skipped; a settlement with no captured
+// operation (reconciled after a crash) is captured from its own `errorInfo`.
+const capturedFailedSubmissions = new Set<string>();
 
-  if (event.type === 'submission_settled' && event.outcome === 'failed') {
-    captureException(event.errorInfo ?? event.error, tags);
-    return;
-  }
+// Best-effort flush of buffered events (notably Sentry Logs, which the SDK
+// batches) on shutdown. Never call process.exit() here — Flue's generated
+// server handles SIGINT/SIGTERM, awaits its lifecycle stop, and exits with
+// the correct code; this listener only flushes within that window. It is not
+// a delivery guarantee: the server exits as soon as its stop resolves and
+// Node does not await promises started by signal listeners, so a flush still
+// in flight can be cut short. Traces and issues are sent during the run;
+// only very-recently-buffered logs are at risk.
+const flush = () => void Sentry.flush(2000);
+if (process.env.SENTRY_DSN) {
+  process.on('SIGINT', flush);
+  process.on('SIGTERM', flush);
+}
 
-  if (event.type === 'log' && event.level === 'error') {
-    Sentry.withScope((scope) => {
-      scope.setTags(tags);
-      scope.setLevel('error');
-      if (Object.hasOwn(event.attributes ?? {}, 'error')) {
-        Sentry.captureException(toError(event.attributes?.error));
-      } else {
-        Sentry.captureMessage(event.message, 'error');
+instrument({
+  // Keyed registration: on a dev reload this module re-evaluates while the
+  // runtime's registry persists, and the newest install wins — the previous
+  // bridge (and its signal listeners) is disposed, so no event is ever
+  // double-reported.
+  key: Symbol.for('flue.sentry.bridge'),
+  observe(event) {
+    if (event.type === 'operation' && event.isError) {
+      captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event), {
+        durationMs: event.durationMs,
+        operationKind: event.operationKind,
+      });
+      if (event.submissionId) capturedFailedSubmissions.add(event.submissionId);
+      return;
+    }
+    if (event.type === 'submission_settled') {
+      const alreadyCaptured = capturedFailedSubmissions.delete(event.submissionId);
+      if (event.outcome === 'failed' && !alreadyCaptured) {
+        captureTerminalFailure(event.errorInfo ?? event.error, correlationTags(event));
       }
-    });
-  }
+      return;
+    }
+    if (event.type === 'log') {
+      Sentry.logger[event.level](event.message, logAttributes(event));
+    }
+  },
+  interceptor: (_operation, _ctx, next) => next(),
+  async dispose() {
+    process.off('SIGINT', flush);
+    process.off('SIGTERM', flush);
+    await Sentry.flush(2000);
+  },
 });
 
-function captureException(
+function captureTerminalFailure(
   error: unknown,
   tags: Record<string, string>,
   context?: Record<string, unknown>,
@@ -57,10 +118,14 @@
   });
 }
 
-function correlationTags(event: FlueEvent): Record<string, string> {
+// Tag keys use the `flue.*` prefix — the same names the trace spans carry —
+// so pivoting on `flue.instance.id` in Sentry's search finds every issue,
+// log, and span from a single agent instance.
+function correlationTags(event: FlueObservation): Record<string, string> {
   const tags: Record<string, string> = {};
   if (event.instanceId) tags['flue.instance.id'] = event.instanceId;
-  if (event.dispatchId) tags['flue.dispatch.id'] = event.dispatchId;
+  if (event.agentName) tags['flue.agent.name'] = event.agentName;
+  if (event.conversationId) tags['flue.conversation.id'] = event.conversationId;
   if (event.submissionId) tags['flue.submission.id'] = event.submissionId;
   if (event.harness) tags['flue.harness'] = event.harness;
   if (event.session) tags['flue.session'] = event.session;
@@ -70,6 +135,72 @@
   return tags;
 }
 
+type LogAttribute = string | number | boolean;
+
+function logAttributes(event: Extract<FlueObservation, { type: 'log' }>): Record<string, LogAttribute> {
+  const attributes: Record<string, LogAttribute> = {};
+  for (const [key, value] of Object.entries(correlationTags(event))) attributes[key] = value;
+  for (const [key, value] of Object.entries(event.attributes ?? {})) {
+    const scrubbed = scrub(value);
+    attributes[`flue.log.${key}`] =
+      typeof scrubbed === 'string' || typeof scrubbed === 'number' || typeof scrubbed === 'boolean'
+        ? scrubbed
+        : stringify(scrubbed);
+  }
+  return attributes;
+}
+
+// The content policy for trace spans. With both record flags off, no model
+// or tool content reaches Sentry at all (`content: false`). With either flag
+// on, the transform admits only the enabled direction, scrubs sensitive keys,
+// and tightens the adapter's default 56 KiB budget to 16 KiB per attribute.
+function contentPolicy(): ContentOption {
+  if (!recordInputs && !recordOutputs) return false;
+  return {
+    transform(content, scope) {
+      if (isInputContent(scope.contentType) && !recordInputs) return undefined;
+      if (isOutputContent(scope.contentType) && !recordOutputs) return undefined;
+      return truncateContent(scrub(content), { maxBytes: 16_384 });
+    },
+  };
+}
+
+function isInputContent(contentType: GenAIContentType): boolean {
+  return (
+    contentType === 'input_messages' ||
+    contentType === 'system_instructions' ||
+    contentType === 'tool_definitions' ||
+    contentType === 'tool_description' ||
+    contentType === 'tool_arguments'
+  );
+}
+
+function isOutputContent(contentType: GenAIContentType): boolean {
+  return (
+    contentType === 'output_messages' ||
+    contentType === 'tool_result' ||
+    contentType === 'exception_message' ||
+    contentType === 'exception_stacktrace'
+  );
+}
+
+const SENSITIVE_KEY = /api[-_]?key|authorization|cookie|dsn|password|secret|token/i;
+
+function scrub(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
+  if (depth > 8) return '[truncated]';
+  if (value instanceof Error) return { name: value.name, message: value.message };
+  if (value === null || typeof value !== 'object') return value;
+  if (seen.has(value)) return '[circular]';
+  seen.add(value);
+  if (Array.isArray(value)) return value.map((item) => scrub(item, seen, depth + 1));
+  return Object.fromEntries(
+    Object.entries(value).map(([key, nested]) => [
+      key,
+      SENSITIVE_KEY.test(key) ? '[redacted]' : scrub(nested, seen, depth + 1),
+    ]),
+  );
+}
+
 function toError(value: unknown): Error {
   if (value instanceof Error) return value;
   if (value && typeof value === 'object') {
@@ -89,3 +220,9 @@
     return String(value);
   }
 }
+
+function clampRate(value: string | undefined, fallback: number): number {
+  if (value === undefined) return fallback;
+  const parsed = Number(value);
+  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : fallback;
+}
```
