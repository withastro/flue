---
title: client.runs
description: Inspect and stream workflow runs.
---

Run APIs inspect workflow runs only. Direct agent prompts and dispatched agent inputs are not runs.

## `client.runs.get(...)`

```ts
get(runId: string): Promise<RunRecord>;
```

Retrieves one workflow-run record from the admin mount path.

## `client.runs.events(...)`

```ts
events(runId: string, options?: { offset?: string; signal?: AbortSignal; backoffOptions?: BackoffOptions }): Promise<FlueEvent[]>;
```

Retrieves events from a workflow run as an array. This is a Durable Streams catch-up read with no live tailing. Omit `offset` for full history, or provide an offset to resume strictly after that point.

## `client.runs.stream(...)`

```ts
stream(runId: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
```

Streams workflow-run events via the [Durable Streams](https://durablestreams.com) protocol. See [Streaming Protocol](/docs/api/streaming-protocol/) for the raw HTTP contract. Returns an async iterable of typed `FlueEvent` objects. When `live` is enabled, the stream tails the run until `run_end`, cancellation, or disconnection. Interrupted streams resume automatically from the last received offset.

```ts
const run = await client.workflows.invoke('summarize', {
  payload: { text: 'Hello' },
});

for await (const event of client.runs.stream(run.runId, { live: true })) {
  console.log(event.type);
  if (event.type === 'run_end') break;
}
```

### `FlueStreamOptions`

| Option   | Type                                    | Default | Description                                              |
| -------- | --------------------------------------- | ------- | -------------------------------------------------------- |
| `offset` | `string`                                | `"-1"`  | Starting offset. `"-1"` for full history, `"now"` for future events only, or an opaque offset from a previous read. |
| `live`   | `boolean \\| 'sse' \\| 'long-poll'`      | `true`  | Enable live tailing. `true` uses long-poll; pass `'sse'` explicitly for SSE. |
| `signal` | `AbortSignal`                           | —       | Stop consuming events when aborted.                      |
| `backoffOptions` | `BackoffOptions`                  | —       | Configure reconnect retry behavior.                      |

### `BackoffOptions`

`BackoffOptions` is exported by `@durable-streams/client` and passed through by Flue for reconnect behavior. Most callers can use the defaults.

### `FlueEventStream<T>`

An async iterable that yields typed events. Use `for await` to consume events. Call `cancel()` to stop the stream explicitly.

```ts
interface FlueEventStream<T> extends AsyncIterable<T> {
  cancel(reason?: unknown): void;
  readonly offset: string;
}
```

`offset` is the resume offset of the most recently fetched batch (the server's `Stream-Next-Offset`). It is batch-granular: it advances per HTTP response, not per delivered event, so every event in a batch observes the batch's final offset. Checkpointing `offset` mid-batch and resuming from it skips the rest of that batch. For per-event checkpoints, use the event's `eventIndex` instead (on workflow-run streams it equals the stream sequence); `flue logs --format ndjson` prints a per-event `offset` derived from it.
