---
title: Errors Reference
description: Reference Flue transport errors, runtime failures, and development diagnostics.
lastReviewedAt: 2026-05-31
---

Flue exposes stable machine-readable error categories through its public transports. Runtime operations, workflow records, CLI commands, development servers, and builds also report failures, but not every surface uses the transport error vocabulary.

## Public transport errors

#### `FluePublicError`

```ts
interface FluePublicError {
  type: string;
  message: string;
  details: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

Caller-safe error details exposed by Flue transports. Unknown failures become a generic `internal_error` payload without leaking their original message. Branch on `type`, not message prose.

| Field     | Meaning                                                                                   |
| --------- | ----------------------------------------------------------------------------------------- |
| `type`    | Stable machine-readable error category.                                                   |
| `message` | Short caller-facing summary.                                                              |
| `details` | Caller-facing explanation.                                                                |
| `dev`     | Additional local development guidance when available.                                     |
| `meta`    | Structured error-specific metadata when available. For example, validation issue details. |

`dev` is omitted unless the runtime has additional guidance and is running locally. Node.js `flue dev` and `flue run` enable it with `FLUE_MODE=local`. Cloudflare Vite development enables it only in development-server mode; preview and production builds render the production envelope.

### Categories

The following categories are stable for framework-owned transport failures. HTTP responses use the listed status code.

| Type                       | HTTP status | Meaning                                                                                   |
| -------------------------- | ----------- | ----------------------------------------------------------------------------------------- |
| `method_not_allowed`       | `405`       | The endpoint does not accept the request method. HTTP responses include `Allow`.          |
| `unsupported_media_type`   | `415`       | A request body was not sent as JSON.                                                      |
| `invalid_json`             | `400`       | A request body could not be read or parsed as JSON.                                       |
| `agent_not_found`          | `404`       | The requested agent is not registered or not exposed through the requested transport.     |
| `workflow_not_found`       | `404`       | The requested workflow is not registered.                                                 |
| `workflow_not_http`        | `404`       | The workflow exists but does not expose an HTTP route.                                    |
| `route_not_found`          | `404`       | No generated default-application route matches the request.                               |
| `run_not_found`            | `404`       | The workflow run is missing, expired, or not owned by the resolved workflow instance.     |
| `run_store_unavailable`    | `501`       | The runtime does not provide workflow-run history storage.                                |
| `run_registry_unavailable` | `501`       | The runtime does not provide cross-run lookup.                                            |
| `invalid_request`          | `400`       | The request shape or protocol message is invalid. Read `details` for the specific reason. |
| `validation_failed`        | `400`       | OpenAPI parameter or query validation failed. `meta.issues` contains issue details.       |
| `internal_error`           | `500`       | An unknown or non-public server failure occurred.                                         |

## Transport envelopes

| Surface             | Envelope                     |
| ------------------- | ---------------------------- |
| HTTP error response | `{ error: FluePublicError }` |

See [Events Reference](/docs/api/events-reference/) for runtime event types.

### Workflow-run streams

Workflow failures normally appear in a terminal `run_end` event with `isError: true`.

## Workflow-run and operation failures

Workflow-run records, `run_end` events, and operation events expose open-ended `error?: unknown` values. Runtime exceptions are commonly serialized as `{ name, message }` when recorded. These failure records are structured observation data, not a closed list of machine-readable transport categories.

## Runtime exceptions

### `ResultUnavailableError`

```ts
class ResultUnavailableError extends Error {
  readonly reason: string;
  readonly assistantText: string;
}
```

Thrown when an agent cannot produce a required structured result, either because it gives up or does not finish after follow-up attempts. Import it from `@flue/runtime` when application logic needs to handle that outcome separately.

### Cancellation

Aborted prompt, skill, task, and shell operations reject with a standard `AbortError` carrying the abort reason as `cause` when the runtime permits it.

Other authoring and execution failures, such as invalid agent profiles, tool definitions, dispatch payloads, model ids, skills, or session operations, reject with human-readable `Error` messages. Those messages are not stable machine-readable categories.

## CLI, build, and development diagnostics

CLI diagnostics are human-oriented messages written to stderr. They do not currently expose stable machine-readable error codes.

| Surface                  | Diagnostic families                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| CLI arguments            | Unsupported flags, missing values, invalid targets, and invalid JSON payloads.                                                  |
| Configuration            | Missing or invalid `flue.config.*` files, invalid default exports, unsupported fields, missing `target`, and environment files. |
| Build                    | Missing source modules, invalid or duplicate source names, generated module exports, imported skills, and target requirements.  |
| Cloudflare build         | Wrangler availability, compatibility settings, reserved bindings, target packages, and filename constraints.                    |
| `flue dev` initial build | Reports the build failure and exits.                                                                                            |
| `flue dev` rebuild       | Reports the rebuild failure and keeps watching for a later fix.                                                                 |

Use the actionable diagnostic prose when resolving these errors. Do not parse it as a stable API. See [`flue build`](/docs/cli/build/) and [`flue dev`](/docs/cli/dev/) for command behavior.

## Application-owned responses

An authored [`app.ts`](/docs/api/routing-api/) owns its request pipeline. Custom routes and middleware may return arbitrary statuses and bodies, including authorization responses. Flue does not impose an `unauthorized` transport category on application-owned responses.

## Stability boundary

| Surface                                                           | Contract                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| `FluePublicError` fields and documented categories                | Stable public transport contract.                        |
| Workflow-run records, workflow events, and operation events       | Structured but open-ended failure data.                  |
| Runtime exception messages and CLI, configuration, build messages | Human-oriented diagnostics subject to refinement.        |
| Generated target internals                                        | Implementation details, not public transport categories. |
