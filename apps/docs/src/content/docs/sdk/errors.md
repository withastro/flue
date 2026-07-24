---
title: Errors
description: The Flue Agent SDK error classes, the HTTP error envelope, and how to discriminate failures.
lastReviewedAt: 2026-07-21
---

The Flue Agent SDK (`@flue/sdk`) exports two error classes of its own — `FlueApiError` (a failed HTTP request) and `FlueExecutionError` (an admitted submission that settled failed or aborted) — plus four re-exported stream error classes owned by `@durable-streams/client`. The wire shapes those errors carry (the HTTP error envelope and the serialized settlement error) are documented on this page.

Every class sets `name` to its class name. Discriminate with `instanceof`; message strings are composed for logging and are not API.

```ts
import { createFlueClient, FlueApiError, FlueExecutionError } from '@flue/sdk';

const conversation = createFlueClient({ url: 'https://example.com/agents/triage/123456' });

try {
  const admission = await conversation.send({ message: { kind: 'user', body: 'Hello' } });
  await conversation.wait(admission);
} catch (error) {
  if (error instanceof FlueApiError) {
    // The HTTP request was rejected: error.status, error.body.
  } else if (error instanceof FlueExecutionError) {
    // The message was admitted, but the submission settled failed or aborted.
  } else {
    throw error;
  }
}
```

## `FlueApiError`

```ts
class FlueApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  constructor(status: number, body: unknown);
}
```

Rejection value of every SDK JSON request that returns a non-2xx response: [`send()`, `abort()`, and `history()`](/docs/sdk/flue-client/). The SDK performs exactly one fetch per JSON request — no retries — so a `FlueApiError` reflects a single server response.

| Field    | Description                                                                                                                                                                                                                                                             |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status` | The HTTP response status.                                                                                                                                                                                                                                               |
| `body`   | The parsed JSON response body when it parses; the raw response text when it does not; the empty string when the response had no body. Deliberately `unknown`: proxies and gateways in front of a deployment can return arbitrary bodies, so the SDK does not normalize. |

The `message` is composed from the status and, when the body carries the Flue error envelope, the envelope's `type` and `message` (for example `Flue API error 404 [agent_instance_not_found]: Agent instance "123456" was not found.`). Match on `status` and `body`, not on the string.

Two methods never produce `FlueApiError`:

- `wait()` reads a durable stream rather than making JSON requests; its transport failures are the [stream errors](#stream-errors) below.
- `observe()` never throws at all; a `FlueApiError` from its internal history reads lands on the observation snapshot instead (see [Errors in `observe()`](#errors-in-observe)).

### The HTTP error envelope

Every error response the Flue runtime renders itself carries one JSON envelope — `{ "error": ... }` with this shape:

```ts
{
  type: string;
  message: string;
  details: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

| Field     | Description                                                                                                                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `type`    | Stable, machine-readable identifier (snake_case, e.g. `agent_instance_not_found`). This is the field to branch on; `message` and `details` wording is not API.                                                   |
| `message` | One-sentence summary, safe to show to any caller.                                                                                                                                                                |
| `details` | Longer caller-safe explanation. Always present (possibly empty).                                                                                                                                                 |
| `dev`     | Developer-audience guidance (fix instructions, configuration hints). Present only when the server runs in local development mode and the error has dev-only guidance; its absence is not a reliable prod signal. |
| `meta`    | Optional structured data, set only where downstream tooling benefits.                                                                                                                                            |

`FlueApiError.body` holds the whole envelope; check the shape before reading fields (`body` stays `unknown` because non-Flue infrastructure can answer too). The server-side error vocabulary — which `type` values exist and their statuses — is documented in the [runtime errors reference](/docs/reference/errors/). Two rejections tied to `send()`'s `uid` condition are worth knowing here:

- `404` `agent_instance_not_found` — a `uid`-conditioned send named an instance that does not exist or whose uid no longer matches (the instance was re-created and the uid names its previous incarnation); nothing was delivered. The two cases are deliberately indistinguishable.
- `409` `agent_instance_exists` — a create-only send (`uid: null`) named an existing instance; `meta.uid` hands back the existing uid (repeated in the `details` prose), so the caller can continue that incarnation without a separate lookup.

Errors thrown by _application_ middleware or non-Flue infrastructure are not enveloped; that is why `body` stays `unknown`.

## `FlueExecutionError`

```ts
type FlueExecutionTarget = 'agent_submission';
type FlueExecutionFailure = 'failed' | 'aborted' | 'terminal_event_missing';

class FlueExecutionError extends Error {
  readonly target: FlueExecutionTarget;
  readonly targetId: string;
  readonly failure: FlueExecutionFailure;
  readonly error: unknown;
  constructor(options: {
    target: FlueExecutionTarget;
    targetId: string;
    failure: FlueExecutionFailure;
    error?: unknown;
  });
}
```

Rejection value of [`wait()`](/docs/sdk/flue-client/): the message was admitted and executed, but the submission settled with an outcome other than `completed`. A `FlueApiError` means the request never got in; a `FlueExecutionError` means the agent ran and did not finish successfully.

| Field      | Description                                                                                                                                                                                                                              |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `target`   | What was being awaited. The union has a single member today, `'agent_submission'`.                                                                                                                                                       |
| `targetId` | The awaited submission's `submissionId` (from the `AgentSendResult` admission).                                                                                                                                                          |
| `failure`  | `'failed'` when the submission settled failed; `'aborted'` when it settled aborted (for example after `abort()`); `'terminal_event_missing'` when the conversation stream ended without a terminal settlement event for this submission. |
| `error`    | The settlement's error payload, when the settlement carried one; `undefined` for `terminal_event_missing`. Typed `unknown` because the value crosses the wire, but errors the runtime itself serializes follow this shape:               |

```ts
{
  name?: string;
  message: string;
  type?: string;
  details?: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

`type`, `details`, and `meta` are present when the underlying failure was a typed runtime error (the same identity vocabulary as the [runtime errors reference](/docs/reference/errors/)); plain errors serialize as `name` and `message` only.

`wait()` distinguishes server-side abortion from caller-side cancellation: a conversation aborted via `abort()` rejects with `FlueExecutionError` (`failure: 'aborted'`), while firing the caller's own `AbortSignal` rejects with the signal's reason — a `DOMException` named `AbortError` when the signal carries no reason — and is not a `FlueExecutionError`. See [Aborts are not SDK errors](#aborts-are-not-sdk-errors).

The conversation wire (`wait()`, `observe()`) validates each chunk against the materialized-conversation protocol, and a protocol mismatch raises an internal `ConversationStreamError` (`name: 'ConversationStreamError'`, not exported). `observe()` recovers from it by rehydrating a fresh snapshot; from `wait()` it propagates as a rejection.

## Stream errors

`wait()`, `observe()`, and `FlueEventStream` iteration read [durable streams](/docs/reference/streaming-protocol/). Transport and protocol failures on those reads come from [`@durable-streams/client`](https://www.npmjs.com/package/@durable-streams/client); the SDK re-exports the classes reachable through its read paths so applications can discriminate them without depending on that package directly. Their shapes are owned by that package and track its releases.

### `DurableStreamError`

```ts
class DurableStreamError extends Error {
  code:
    | 'NOT_FOUND'
    | 'CONFLICT_SEQ'
    | 'CONFLICT_EXISTS'
    | 'BAD_REQUEST'
    | 'BUSY'
    | 'SSE_NOT_SUPPORTED'
    | 'UNAUTHORIZED'
    | 'FORBIDDEN'
    | 'RATE_LIMITED'
    | 'ALREADY_CONSUMED'
    | 'ALREADY_CLOSED'
    | 'PARSE_ERROR'
    | 'STREAM_CLOSED'
    | 'UNKNOWN';
  status?: number;
  details?: unknown;
}
```

Protocol-level stream failure — a malformed or unparseable stream response, an SSE upgrade the server does not support, or an HTTP status mapped to a structured code.

| Field     | Description                                                                                                                     |
| --------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `code`    | Structured code for programmatic handling (the union above; the `DurableStreamErrorCode` type alias itself is not re-exported). |
| `status`  | HTTP status, when the failure maps to a response.                                                                               |
| `details` | Additional data, typically the raw response body.                                                                               |

### `StreamClosedError`

```ts
class StreamClosedError extends DurableStreamError {
  readonly code = 'STREAM_CLOSED';
  readonly status = 409;
  readonly streamClosed = true;
  readonly finalOffset?: string;
}
```

`DurableStreamError` subclass reporting an operation against a stream that has already been closed. `finalOffset` carries the stream's final offset when the response provided one.

### `FetchError`

```ts
class FetchError extends Error {
  status: number;
  text?: string;
  json?: object;
  headers: Record<string, string>;
  url: string;
}
```

A stream HTTP request that failed without a protocol-level classification. The stream layer retries transient failures with exponential backoff (429, 503, all 5xx, and network errors; by default indefinitely — bound it via the `backoffOptions` accepted by `wait()` and `observe()`), so with default options a `FetchError` surfaces for non-retryable client errors: 4xx other than 429.

| Field           | Description                                                                       |
| --------------- | --------------------------------------------------------------------------------- |
| `status`        | HTTP status of the failed request.                                                |
| `text` / `json` | The response body, as text or parsed JSON depending on the response content type. |
| `headers`       | The response headers.                                                             |
| `url`           | The requested URL.                                                                |

### `FetchBackoffAbortError`

```ts
class FetchBackoffAbortError extends Error {}
```

A stream request was abandoned because its signal aborted during retry backoff. No extra fields. Most caller-initiated aborts do not surface this class — SDK stream iteration ends quietly on the caller's own signal, and `wait()` then rejects with the signal's reason — but it can appear where the stream layer's abort races its retry loop.

## Errors in `observe()`

`observe()` neither throws nor rejects. Failures surface on the observation snapshot (`getSnapshot().phase` and `.error`):

- A `404` from the initial history read sets `phase: 'absent'` with no error — the conversation does not exist yet.
- A `400`, `401`, or `403` (from any error value carrying a numeric `status`, such as `FlueApiError` or `FetchError`) is fatal: `phase: 'error'` with the error on `snapshot.error`. No further retries.
- Every other failure — network errors, 5xx, a stream that ends unexpectedly — schedules a rehydrate with exponential delay (1 s doubling, capped at 30 s): `phase: 'connecting'` with the pending error on `snapshot.error`.
- Closing (via `close()` or the `signal` option) sets `phase: 'closed'`.

The full observation contract is on the [client page](/docs/sdk/flue-client/).

## Aborts are not SDK errors

Cancellation surfaces as the abort reason, never as a Flue error class:

- `send()`, `abort()`, and `history()` reject with whatever the fetch implementation throws for an aborted request — a `DOMException` named `AbortError` under the standard `fetch`.
- `wait()` rejects with `signal.reason`, or a `DOMException` named `AbortError` when the signal carries no reason.
- `FlueEventStream` iteration does not throw on cancellation: `cancel()` (or breaking out of `for await`) ends iteration with `done: true`.

Check `error.name === 'AbortError'` (or your own `signal.reason`) before treating a rejection as a failure.

## Construction errors

[`createFlueClient()`](/docs/sdk/create-flue-client/) throws synchronously — with native errors, not an SDK class — when the conversation URL cannot be resolved:

- A relative `url` outside a browser throws `TypeError: relative url requires a browser; pass an absolute URL`. In a browser, relative URLs resolve against `location.origin`.
- A `url` that is not a valid URL throws the native `TypeError` from the `URL` constructor.

No network activity happens at construction; everything else fails at call time through the classes above.
