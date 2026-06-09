---
title: client.workflows
description: Start workflow runs and receive their run ID and stream URL.
---

## `client.workflows.invoke(...)`

```ts
invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
```

Starts a workflow run. Returns the run ID and a fully resolved stream URL for observing run events.

```ts
const run = await client.workflows.invoke('summarize', {
  payload: { text: 'Summarize this document.' },
});

console.log(run.runId);     // "workflow:summarize:01JX..."
console.log(run.streamUrl); // "https://example.com/api/runs/workflow%3Asummarize%3A01JX..."
```

Use the returned `runId` with [`client.runs`](/docs/sdk/runs/) to stream events, fetch all events, or retrieve run metadata.

### `WorkflowInvokeOptions`

| Field     | Type          | Default | Description              |
| --------- | ------------- | ------- | ------------------------ |
| `payload` | `unknown`     | —       | Workflow-defined payload. |
| `signal`  | `AbortSignal` | —       | Cancel the HTTP request. |

### `WorkflowInvokeResult`

```ts
interface WorkflowInvokeResult {
  runId: string;
  streamUrl: string;
}
```

| Field       | Description                                                      |
| ----------- | ---------------------------------------------------------------- |
| `runId`     | The workflow run ID.                                             |
| `streamUrl` | Fully resolved Durable Streams URL for observing run events.     |
