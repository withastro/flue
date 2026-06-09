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
events(runId: string, options?: { signal?: AbortSignal }): Promise<FlueEvent[]>;
```

Retrieves all events from a workflow run as an array. This is a Durable Streams catch-up read with no live tailing — it returns all persisted events and resolves.

## `client.runs.stream(...)`

```ts
stream(runId: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
```

Streams workflow-run events via the [Durable Streams](https://durablestreams.com) protocol. Returns an async iterable of typed `FlueEvent` objects. When `live` is enabled, the stream tails the run until `run_end`, cancellation, or disconnection. Interrupted streams resume automatically from the last received offset.

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

### `FlueEventStream<T>`

An async iterable that yields typed events. Use `for await` to consume events. Call `cancel()` to stop the stream explicitly.

```ts
interface FlueEventStream<T> extends AsyncIterable<T> {
  cancel(reason?: unknown): void;
}
```
