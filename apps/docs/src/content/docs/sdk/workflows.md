---
title: client.workflows
description: Start workflow runs and receive their run ID and stream URL.
---

## `client.workflows.invoke(...)`

```ts
invoke(name: string, options: WorkflowInvokeOptions & { wait: 'result' }): Promise<WorkflowWaitResult>;
invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
```

Starts a workflow run. Returns the run ID and the server-provided stream coordinates for observing run events.

```ts
const run = await client.workflows.invoke('summarize', {
  payload: { text: 'Summarize this document.' },
});

console.log(run.runId); // "run_01JX..."
console.log(run.streamUrl); // "https://example.com/api/runs/run_01JX..."
console.log(run.offset); // "-1"
```

Use the returned `runId` with [`client.runs`](/docs/sdk/runs/) to stream events, fetch all events, or retrieve run metadata.

Pass `wait: 'result'` to hold the request open until the run finishes and resolve with its terminal result:

```ts
const run = await client.workflows.invoke('summarize', {
  payload: { text: 'Summarize this document.' },
  wait: 'result',
});

console.log(run.result); // the workflow's return value
```

### `WorkflowInvokeOptions`

| Field     | Type          | Default | Description                                                      |
| --------- | ------------- | ------- | ---------------------------------------------------------------- |
| `payload` | `unknown`     | —       | Workflow-defined payload.                                        |
| `wait`    | `'result'`    | —       | Wait for the run to finish and resolve with its terminal result. |
| `signal`  | `AbortSignal` | —       | Cancel the HTTP request.                                         |

### `WorkflowInvokeResult`

```ts
interface WorkflowInvokeResult {
  runId: string;
  streamUrl: string;
  offset: string;
}
```

| Field       | Description                                                                                                     |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `runId`     | The workflow run ID.                                                                                            |
| `streamUrl` | Fully resolved Durable Streams URL for observing run events.                                                    |
| `offset`    | Opaque stream offset captured at admission. Reading `streamUrl` from it yields the run's events from the start. |

All fields are server-provided; treat `offset` as an opaque token and do not construct one.

### `WorkflowWaitResult`

```ts
interface WorkflowWaitResult extends WorkflowInvokeResult {
  result: unknown;
}
```

Returned when `wait: 'result'` is passed. Adds the workflow run's terminal `result` to the fields above.
