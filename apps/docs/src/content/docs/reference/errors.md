---
title: Errors Reference
description: The FlueError hierarchy, stable error type codes, the HTTP error envelope, settlement errors, and error classification on live observations.
lastReviewedAt: 2026-07-21
---

Typed framework failures are `FlueError` subclasses with a stable machine-readable `type` code, plus two plain-`Error` classes documented below (`AgentRunError` and `ResultUnavailableError`). Cancellation rejects with a `DOMException` named `AbortError`. Misuse of programmatic entry points (calling `dispatch()` or `init()` before the runtime is configured, an empty instance id) throws plain `Error`s whose `[flue]`-prefixed messages are prose, not API. Error classes are exported from `@flue/runtime`, with two exceptions: the Cloudflare binding surface lives on `@flue/runtime/cloudflare`, and the persistence store classes live on `@flue/runtime/adapter`.

The Flue Agent SDK's error classes (`FlueApiError`, `FlueExecutionError`, stream errors) are documented in the [SDK errors reference](/docs/sdk/errors/). They wrap the same wire envelope and settlement shapes defined on this page.

## `FlueError`

```ts
class FlueError extends Error {
  readonly type: string;
  readonly details: string;
  readonly dev: string;
  readonly meta: Record<string, unknown> | undefined;
  readonly cause: unknown;
}
```

The base class for framework-typed errors. Distinguish Flue failures from arbitrary errors with `err instanceof FlueError`, then narrow with a concrete subclass or the `type` field.

- `type` — stable snake_case identifier, one constant per subclass. This is the machine-readable contract; match on it in code and telemetry.
- `message` — one caller-safe sentence. Prose, not API: message strings may change between versions.
- `details` — longer caller-safe prose about the request and what the caller can do. Always rendered on the wire. `''` when the class has nothing further to say.
- `dev` — developer-audience prose: available alternatives, filesystem layout, source-level fix instructions. Rendered on the wire only in local development. `''` when the class has nothing dev-specific.
- `meta` — optional structured data. Set only by the subclasses documented as carrying it; included on the wire in every mode when set.
- `cause` — the underlying error when wrapping. Logged server-side; never sent over the wire.
- `name` — not a discriminator. Most subclasses report `'FlueError'` or `'FlueHttpError'`; only some override it. Use `instanceof` or `type`.

The HTTP base class (`FlueHttpError`, adding `readonly status: number` and `readonly headers: Record<string, string> | undefined`) is not exported. Its two exported subclasses, `AgentInstanceNotFoundError` and `AgentInstanceExistsError`, expose `status` and `headers` through it.

## HTTP error envelope

Every error response from an agent route, a mounted `createAgentRouter()` app, or a channel router carries one JSON body shape:

```json
{
  "error": {
    "type": "stream_not_found",
    "message": "Event stream \"...\" was not found.",
    "details": "Streams are created when their agent instance receives its first prompt.",
    "dev": "...",
    "meta": {}
  }
}
```

- `type`, `message`, `details` — always present.
- `dev` — present only when the server runs in local development (`flue dev`, `flue run`) and the error class populated it. Its presence is not a reliable mode signal: errors whose class set `dev: ''` omit the field in every mode.
- `meta` — present whenever the error class set it, in development and production alike.
- `cause` and stack traces — never present.

Status resolution:

- An HTTP-typed `FlueError` renders with its class-owned status (listed per type below) plus any class-owned headers (`Allow` on 405, `Retry-After: 1` on 503).
- A non-HTTP `FlueError` that escapes to a route renders its typed envelope with status 500 and is logged server-side.
- Any non-`FlueError` thrown value renders as a generic 500 `internal_error` envelope. The original error is logged server-side in full and nothing about it reaches the wire.

Every error response also carries `content-type: application/json`, `x-content-type-options: nosniff`, and `cross-origin-resource-policy: cross-origin`.

Two route responses deliberately omit the envelope: `HEAD` conversation reads answer errors with status and headers only (no body), and a long-poll read aborted by the client returns status 499 with an empty body.

## Route error types

The wire `type` codes agent routes produce, with their status. Only `agent_instance_not_found` and `agent_instance_exists` have importable classes; match the rest on `error.type`. The routes themselves are documented in the [Streaming Protocol Reference](/docs/reference/streaming-protocol/).

- `invalid_request` — 400. Malformed request: bad URL or parameter shapes, an empty instance-id segment, invalid dispatch payloads, a `uid` condition combined with `initialData`, or creation data that fails the agent's `initialDataSchema`. `details` states the specific reason.
- `invalid_json` — 400. Request body present but not parseable as JSON. `details` includes the parser's report.
- `unsupported_media_type` — 415. Request body present without a `Content-Type: application/json` header.
- `method_not_allowed` — 405. Response carries an `Allow` header listing the accepted methods.
- `route_not_found` — 404. No route matches the method and path. Registered routes are not enumerated.
- `stream_not_found` — 404. Conversation stream read for an instance that has never received a prompt.
- `attachment_not_found` — 404. Unknown attachment id, or an attachment belonging to a conversation other than the default one.
- `agent_instance_not_found` — 404. See [`AgentInstanceNotFoundError`](#agentinstancenotfounderror).
- `agent_instance_exists` — 409. See [`AgentInstanceExistsError`](#agentinstanceexistserror).
- `runtime_unavailable` — 503. The local dev runtime is reloading, draining, or failed to load. Carries `Retry-After: 1` and `meta.state` (`'loading' | 'draining' | 'failed'`); in dev mode `dev` carries the underlying load failure.
- `internal_error` — 500. The generic redaction for unexpected server errors.

Admission of a send — over HTTP or through `dispatch()` and `init().dispatch()` — also rejects with `type: 'invalid_request'` for payload misuse: a `uid` string condition combined with `initialData`, creation data failing the agent's `initialDataSchema`, or a non-function `agent` argument. That class (`InvalidRequestError`) is not exported; match it with `instanceof FlueError` and the `type` field.

Internal invariant and persistence failures have their own codes, which can appear in a 500 envelope or a settlement error: `conversation_record_invariant` (no importable class), the store codes carried by the `@flue/runtime/adapter` classes ([`AttachmentConflictError`](#attachmentconflicterror), [`AttachmentIntegrityError`](#attachmentintegrityerror), [`ConversationStreamStoreError`](#conversationstreamstoreerror), [`PersistedSchemaVersionError`](#persistedschemaversionerror)), and `cloudflare_ai_binding_error` ([`CloudflareAIBindingError`](#cloudflareaibindingerror) on `@flue/runtime/cloudflare`).

Authored routes and middleware in an [`app.ts`](/docs/guide/routing/) own their responses; the envelope and status vocabulary above apply only to framework-owned routes.

## `AgentInstanceExistsError`

```ts
class AgentInstanceExistsError extends FlueError {
  // type: 'agent_instance_exists', status: 409
  readonly uid: string | undefined;
}
```

A create-only send (`uid: null`) — `dispatch()` or `init().dispatch()` with the condition, or the equivalent HTTP body fields — named an instance that already exists. Raised synchronously at admission; nothing durable is created when it fires. Over HTTP it renders with status 409; programmatically the returned promise rejects with the class instance.

- `uid` — the existing incarnation's uid, usable directly as the continue condition. `undefined` for instances created before uids shipped. The uid also rides the wire envelope as `meta.uid` (and appears in the `details` prose), so HTTP callers can continue the existing instance without a separate lookup.

## `AgentInstanceNotFoundError`

```ts
class AgentInstanceNotFoundError extends FlueError // type: 'agent_instance_not_found', status: 404
```

A continue-only send (`uid: '<string>'`) — `dispatch()` or `init().dispatch()` with the condition, or the equivalent HTTP body fields — named an instance that does not exist or whose uid does not match. Both cases produce the same error: to a caller holding a uid condition, the known incarnation is absent either way. Raised synchronously at admission; nothing durable is created when it fires. Over HTTP it renders with status 404; programmatically the returned promise rejects with the class instance. Send without a `uid` to deliver unconditionally.

Also the rejection of an `init().read()` addressed to an instance that does not exist: a read waits for settlement, and an instance that was never contacted has nothing to settle, so the miss fails fast instead of waiting forever.

## `AgentRunError`

```ts
class AgentRunError extends Error {
  readonly outcome: 'failed' | 'aborted';
  readonly submissionId: string;
}
```

The rejection of an awaited `init().read()` call whose submission settled `failed` or `aborted`. Not a `FlueError`.

- `outcome` — the non-completed settlement outcome.
- `submissionId` — the settled submission.
- `cause` — the settlement's serialized error (the `{ name?, message, type?, details?, meta? }` shape under [Settlement error shape](#settlement-error-shape)) when the settlement carried one.

A `read()` call whose `signal` is already fired rejects with the signal's reason instead of an `AgentRunError` — by default a `DOMException` named `AbortError`. This is a local cancellation of the read only; the submission itself keeps running and settles independently. To durably stop the agent's work, call `abort()`.

## `AttachmentConflictError`

```ts
// from '@flue/runtime/adapter'
class AttachmentConflictError extends FlueError // type: 'attachment_conflict'
```

An attachment id was reused with different content, metadata, or ownership. Exported from `@flue/runtime/adapter`, alongside the store contracts it guards; see the [Data Persistence API](/docs/reference/data-persistence-api/). Fires inside store operations, not as an HTTP category; one that escapes to a route renders as a 500 with its own type code. `meta` carries `path` and `attachmentId`.

## `AttachmentIntegrityError`

```ts
// from '@flue/runtime/adapter'
class AttachmentIntegrityError extends FlueError // type: 'attachment_integrity'
```

Attachment bytes failed integrity verification. Exported from `@flue/runtime/adapter`, alongside the store contracts it guards; see the [Data Persistence API](/docs/reference/data-persistence-api/). Fires inside store operations, not as an HTTP category; one that escapes to a route renders as a 500 with its own type code. `meta` carries `attachmentId` and `reason` (`'size' | 'digest' | 'chunks'`).

## `AttachmentNotAvailableError`

```ts
class AttachmentNotAvailableError extends FlueError // type: 'attachment_not_available'
```

Thrown by the harness operations when a delegated task referenced an attachment id not visible in the calling session's conversation. `meta` carries `attachmentId`.

## `CloudflareAIBindingError`

```ts
// from '@flue/runtime/cloudflare'
class CloudflareAIBindingError extends FlueError {
  // type: 'cloudflare_ai_binding_error'
  constructor(options: { message?: string; status?: number; statusText?: string; body?: string });
}
```

A Workers AI binding request failed. Exported from `@flue/runtime/cloudflare`; specific to the Workers AI binding path and absent from the root barrel. The provider response body rides in `message` (bounded at 2000 characters) as well as `details`, because retry and overflow classification read the persisted assistant error message. `meta` carries `status` and `statusText` when known, plus `reason: 'request_too_large'` on 413 responses so telemetry can separate self-healing context overflow from a binding outage. The constructor is public so applications can build instances in regression tests against the installed runtime.

## `ConversationStreamStoreError`

```ts
// from '@flue/runtime/adapter'
class ConversationStreamStoreError extends FlueError // type: 'conversation_stream_store_failure'
```

A canonical conversation stream operation was rejected; the stream remains unchanged. Exported from `@flue/runtime/adapter`, alongside the store contracts it guards; see the [Data Persistence API](/docs/reference/data-persistence-api/). Fires inside store operations, not as an HTTP category; one that escapes to a route renders as a 500 with its own type code. `meta` carries `operation`, `path`, and `reason`.

The related `conversation_record_invariant` code (a persisted conversation record violating the stream contract) has no exported class.

## `DelegationDepthExceededError`

```ts
class DelegationDepthExceededError extends FlueError // type: 'delegation_depth_exceeded'
```

Thrown by the harness operations when the chain of nested `task()` / harness-tool delegations exceeded the maximum depth. `message` includes the limit.

## `InstrumentationAlreadyInstalledError`

```ts
class InstrumentationAlreadyInstalledError extends FlueError // type: 'instrumentation_already_installed'
```

`instrument()` was called while an instrumentation owner of the same kind was active. Dispose the active one first.

## `OperationFailedError`

```ts
class OperationFailedError extends FlueError // type: 'operation_failed'
```

A harness operation — `prompt()`, `skill()`, `task()`, `shell()`, or `compact()` on `FlueHarness` and `FlueSession` — ran but did not complete: the underlying model call errored, or a durable input could not be persisted or recovered. `meta` carries `operation` and `reason` (the unwrapped failure text, also embedded in `message`; both are prose, not API).

## `PersistedSchemaVersionError`

```ts
// from '@flue/runtime/adapter'
class PersistedSchemaVersionError extends FlueError // type: 'persisted_schema_version_unsupported'
```

The database records a schema version this runtime does not support: stamped by a newer Flue version (after a rollback) or carrying an unrecognized version marker. Thrown when the store is opened, at startup. Exported from `@flue/runtime/adapter`, alongside the store contracts it guards; see the [Data Persistence API](/docs/reference/data-persistence-api/). `meta` carries `storedVersion` and `supportedVersion`.

## `ResultUnavailableError`

```ts
class ResultUnavailableError extends Error {
  readonly reason: string;
  readonly assistantText: string;
}
```

Thrown by `prompt()`, `skill()`, and `task()` when the call set `options.result` and the model invoked the framework's give-up tool instead of producing schema-conforming data. Not a `FlueError`.

- `reason` — the model-supplied explanation.
- `assistantText` — the assistant transcript accumulated before the give-up.

## `SandboxOperationUnsupportedError`

```ts
class SandboxOperationUnsupportedError extends FlueError // type: 'sandbox_operation_unsupported'
```

A sandbox adapter rejected an operation or option set it does not implement, before modifying the filesystem. `meta` carries `operation`, `provider`, and `options`. See the [Sandbox API Reference](/docs/reference/sandbox-api/).

## `SessionBusyError`

```ts
class SessionBusyError extends FlueError // type: 'session_busy'
```

A harness operation — `prompt()`, `skill()`, `task()`, `shell()`, or `compact()` — was invoked while the session was already running one. Sessions run one operation at a time; open another session for parallel branches.

## `SessionNotFoundError`

```ts
class SessionNotFoundError extends FlueError // type: 'session_not_found'
```

An internal session lookup failure inside the harness. The public harness operations get-or-create the default session and cannot hit it.

## `SkillDefinitionValidationError`

```ts
class SkillDefinitionValidationError extends FlueError // type: 'skill_definition_validation'
```

`defineSkill()` received an invalid definition. `meta.issues` carries the [`ValidationIssue[]`](#validationissue).

## `SkillNotRegisteredError`

```ts
class SkillNotRegisteredError extends FlueError // type: 'skill_not_registered'
```

`skill(name)` named a skill not discovered in the session's sandbox at init time. Packaged skill references imported from `SKILL.md` bypass discovery.

## `SubagentNotDeclaredError`

```ts
class SubagentNotDeclaredError extends FlueError // type: 'subagent_not_declared'
```

`task({ agent })` named a subagent absent from the agent's declarations.

## `SubmissionAbortedError`

```ts
class SubmissionAbortedError extends FlueError // type: 'submission_aborted'
```

A terminal error a durable submission settles with: it becomes the `error` of the `submission_settled` record and event (the [settlement error shape](#settlement-error-shape) below) and rejects a waiting settlement observer (`init().read()`, the SDK's `wait()`). The instance's work was aborted (the route's `POST .../abort`, or the `init()` handle's `abort()`). Abort stops all in-flight and queued work for the instance. Abort is a distinct terminal outcome, not a failure: a submission that already committed its terminal record is never aborted, and an abort that loses the race to a completed response settles as completed.

## `SubmissionInterruptedError`

```ts
class SubmissionInterruptedError extends FlueError // type: 'submission_interrupted'
```

A terminal error a durable submission settles with: it becomes the `error` of the `submission_settled` record and event (the [settlement error shape](#settlement-error-shape) below) and rejects a waiting settlement observer (`init().read()`, the SDK's `wait()`). Every processing attempt was interrupted (process crash, restart, shutdown) before the submission's input was applied; the shared attempt budget ran out with no model call ever started. It reflects the agent's `durability` configuration; see the [Durability guide](/docs/guide/durability/) for the attempt and timeout model. `meta` carries `phase: 'retry_exhausted_before_input'`, `attemptCount`, and `maxAttempts`.

## `SubmissionRetryExhaustedError`

```ts
class SubmissionRetryExhaustedError extends FlueError // type: 'submission_retry_exhausted'
```

A terminal error a durable submission settles with: it becomes the `error` of the `submission_settled` record and event (the [settlement error shape](#settlement-error-shape) below) and rejects a waiting settlement observer (`init().read()`, the SDK's `wait()`). Recovery re-attempted an interrupted submission after input application until `durability.maxAttempts` ran out without a completed response; see the [Durability guide](/docs/guide/durability/) for the attempt and timeout model. When terminalization settled tool calls whose outcomes could not be confirmed, `meta.interruptedTools` lists them as `{ name, id }` pairs; each has an explicit interrupted-error outcome in the conversation and was never assumed complete or retried. `meta` also carries `attemptCount` and `maxAttempts`.

## `SubmissionTimeoutError`

```ts
class SubmissionTimeoutError extends FlueError // type: 'submission_timeout'
```

A terminal error a durable submission settles with: it becomes the `error` of the `submission_settled` record and event (the [settlement error shape](#settlement-error-shape) below) and rejects a waiting settlement observer (`init().read()`, the SDK's `wait()`). The submission exceeded `durability.timeoutMs`; see the [Durability guide](/docs/guide/durability/) for the attempt and timeout model.

## `ToolInputValidationError`

```ts
class ToolInputValidationError extends FlueError // type: 'tool_input_validation'
```

Model-supplied arguments failed the tool's `input` schema. During a model turn it becomes an error tool result delivered back to the model — the submission continues, and the message is addressed to the model, which may correct the arguments and call again; outside a model turn the error propagates to the caller. `meta` carries `tool` and `issues`.

## `ToolNameConflictError`

```ts
class ToolNameConflictError extends FlueError // type: 'tool_name_conflict'
```

A tool list contained a duplicate name, or a custom or adapter tool used a framework-reserved name. Raised when the session assembles its tools, before any model call. See the [Tools guide](/docs/guide/tools/) for the authoring surface.

## `ToolOutputSerializationError`

```ts
class ToolOutputSerializationError extends FlueError // type: 'tool_output_serialization'
```

The tool's return value is not JSON-serializable, or the tool returned `undefined` while declaring an `output` schema. During a model turn it becomes an error tool result delivered back to the model — the submission continues; outside a model turn the error propagates to the caller. `meta` carries `tool`; `cause` carries the serialization failure when one exists.

## `ToolOutputValidationError`

```ts
class ToolOutputValidationError extends FlueError // type: 'tool_output_validation'
```

The tool's return value failed its `output` schema. During a model turn it becomes an error tool result delivered back to the model — the submission continues; outside a model turn the error propagates to the caller. `meta` carries `tool` and `issues`.

## `ValidationIssue`

```ts
interface ValidationIssue {
  readonly message: string;
  readonly path?: readonly PropertyKey[];
}

type ToolValidationIssue = ValidationIssue;
```

One validation failure in Standard Schema's issues shape; `path` segments are the property keys leading to the failing value. Carried in `meta.issues` by the validation errors above.

## Settlement error shape

The `submission_settled` event, the durable settlement record, and the `submission-settled` conversation stream chunk carry the outcome and, for `failed` and `aborted`, a serialized error:

```ts
{
  type: 'submission_settled';
  submissionId: string;
  outcome: 'completed' | 'failed' | 'aborted';
  error?: {
    name?: string;
    message: string;
    type?: string;
    details?: string;
    dev?: string;
    meta?: Record<string, unknown>;
  };
}
```

A `FlueError` serializes with its `name`, `message`, `type`, `details`, and `meta`. Any other failure cause is redacted to a generic `internal_error` entry — non-Flue error messages never reach settlement records or the wire. Settlement errors never carry a stack.

## `WORKERS_AI_OVERFLOW_MARKER` and `RETRYABLE_INTERRUPTION_MARKER`

```ts
const WORKERS_AI_OVERFLOW_MARKER = '(request_too_large)';
const RETRYABLE_INTERRUPTION_MARKER = '(retryable_interruption)';
```

Message-string markers used where no typed error object survives — classification reads the persisted assistant error message.

- `WORKERS_AI_OVERFLOW_MARKER` — appended to a binding 413 error message; the compaction layer matches it to trigger context-overflow recovery (compact and retry).
- `RETRYABLE_INTERRUPTION_MARKER` — stamped only by throw sites that can prove the failure was a transient interruption (for example a Workers AI stream ending without an error frame or finish reason); retry classification matches it before falling back to message-pattern heuristics.

Applications that surface provider errors can match or strip these markers. Their string values are the contract.

## `errorInfo` on live observations

`FlueObservation` values delivered to in-process `observe()` subscribers carry classified error detail on failed activity. The field's shape (the interface itself is not exported):

```ts
// FlueObservation
errorInfo?: {
  type: string;
  name?: string;
  code?: string;
  message?: string;
  meta?: Record<string, unknown>;
  stack?: string;
};
```

Classification rules, applied to the thrown value:

- A `DOMException` named `AbortError` → `type: 'AbortError'`.
- A `FlueError` → `type` is the error's stable code; `meta` is the error's framework-owned metadata (for example validation issues), so observers get structured failure detail without parsing the message.
- Any other object → `type` is its string `type`, else `code`, else `name`, else `'_OTHER'`; `name`, `code`, and `message` are carried when they are strings.
- A string → `{ type: '_OTHER', message }`; anything else → `{ type: '_OTHER' }`.
- `stack` — the throw-site stack, present only when the failure was observed live from a real `Error` instance, never from arbitrary thrown objects.

`errorInfo` appears on failed `tool` observations, failed `operation` observations, and non-completed `submission_settled` observations. Failures of the caller-driven `shell()` bash tool classify to the `type`/`name`/`message` subset only, without `meta` or `stack`. `errorInfo` is in-process only: the durable-shaped `error` fields on `operation` and `compaction` events serialize to `{ name, message }` (plus `type`, `details`, `meta` for `FlueError`s), and durable records never carry `stack` — stacks expose filesystem paths and deployment layout, so they stay out of anything persisted, replayed, or sent over HTTP. See the [Events Reference](/docs/reference/events/) for the observation types and the [Observability guide](/docs/guide/observability/) for subscriber setup.

## Turn error normalization

Model-call failures do not throw through the agent render. They normalize into the `turn` event's `response` and, when the submission cannot recover, settle the submission with `OperationFailedError` or a durable submission error.

```ts
// turn event
{
  type: 'turn';
  turnId: string;
  purpose: 'agent' | 'compaction' | 'compaction_prefix';
  durationMs: number;
  request: ModelRequestInfo;
  response: ModelResponse;
  isError: boolean;
}

interface ModelResponse {
  responseId?: string;
  responseModel?: string;
  output?: LlmAssistantMessage;
  usage?: PromptUsage;
  finishReason?: string;
  providerFinishReason?: string;
  gatewayLogId?: string;
  error?: /* errorInfo shape above */;
}
```

- `finishReason` — the normalized finish vocabulary: `'stop'`, `'length'`, `'toolUse'`, `'error'`, or `'aborted'`. Every provider's native finish value maps into this set.
- `providerFinishReason` — the provider's exact pre-normalization finish value (for example Workers AI `tool_calls` behind the normalized `toolUse`). Telemetry only; never part of replay or execution identity.
- `gatewayLogId` — response-level Cloudflare AI Gateway log correlation (`cf-aig-log-id`), read from the response's own headers so concurrent requests cannot cross-attribute it. Telemetry only.
- `error` — the classified error, present when the request threw or the assistant message carries a provider error message. A bare provider error string classifies as `type: '_OTHER'` with the text in `message`.
- `isError` — true when the request threw or `finishReason` is `'error'` or `'aborted'`.

## Boundaries

- `type` strings are the stable machine contract. `message`, `details`, and `dev` prose may change between versions; do not parse them.
- There is no exported enum or list of error codes; the codes live on the classes and on this page.
- There is no per-provider error hierarchy. Provider failures normalize into turn results and, terminally, `operation_failed` or the durable submission errors. The one provider-specific class is `CloudflareAIBindingError`.
- Cancellation is never a `FlueError`: aborted operations and dispatches reject with a `DOMException` named `AbortError`.
- The wire never carries `cause`, stacks, or non-Flue error messages; all three stay in server-side logs.
- CLI, configuration, and build diagnostics (`flue` commands, `flue.config.*` validation, the Vite plugin) are human-oriented stderr prose without stable machine-readable codes.
- Application-owned routes and middleware in an authored `app.ts` return whatever statuses and bodies they choose; Flue imposes no envelope or category (for example, no `unauthorized` type) on them.
