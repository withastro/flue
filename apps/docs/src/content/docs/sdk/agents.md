---
title: client.agents
description: Invoke persistent agent instances and read their conversations.
---

Direct agent APIs interact with persistent agent instances. They use an agent name and instance id. Each agent instance is a single conversation. Direct agent interactions do not create workflow runs and do not emit `runId`.

## `client.agents.prompt(...)`

```ts
prompt(name: string, id: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
```

Sends one prompt to a persistent agent instance and waits for the terminal result. This uses `POST /agents/:name/:id?wait=result`.

The prompt is a durable submission. If the request disconnects before settlement, recovery continues in the background and the result remains available from the agent conversation.

### `AgentPromptOptions`

| Field     | Type                 | Description                                                  |
| --------- | -------------------- | ------------------------------------------------------------ |
| `message` | `string`             | Prompt sent to the agent instance.                           |
| `images`  | `AgentPromptImage[]` | Optional image attachments. Requires a vision-capable model. |
| `signal`  | `AbortSignal`        | Cancel the in-flight HTTP request.                           |

### `AgentPromptImage`

```ts
interface AgentPromptImage {
  type: 'image';
  data: string;
  mimeType: string;
}
```

`data` is the base64-encoded image content and `mimeType` its media type, such as `image/png`. The server rejects images whose `data` exceeds 14 MiB of base64 characters.

### `AgentPromptResult`

```ts
interface AgentPromptResult extends AgentSendResult {
  result: AgentPromptResponse;
}
```

### `AgentPromptResponse`

```ts
interface AgentPromptResponse {
  text: string;
  usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    totalTokens: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
  model: { provider: string; id: string };
}
```

| Field   | Type     | Description                                                             |
| ------- | -------- | ----------------------------------------------------------------------- |
| `text`  | `string` | Assistant text returned by the prompt.                                  |
| `usage` | object   | Aggregated token and cost usage for model work performed by the prompt. |
| `model` | object   | Model selected for the prompt's primary turn.                           |

## `client.agents.send(...)`

```ts
send(name: string, id: string, options: AgentPromptOptions): Promise<AgentSendResult>;
```

Starts one prompt without waiting for completion. This uses the default `POST /agents/:name/:id` response, which returns `202`. Pass the result to `agents.wait()` to wait for settlement, or use its `offset` with `agents.updates()` when retaining conversation state locally.

### `AgentSendResult`

```ts
interface AgentSendResult {
  streamUrl: string;
  offset: string;
  submissionId: string;
}
```

Both `prompt()` and `send()` return the required `submissionId`, which identifies the durable direct submission.

## `client.agents.history(...)`

```ts
history(name: string, id: string, options?: AgentConversationHistoryOptions): Promise<AgentConversationSnapshot>;
```

Returns one materialized conversation snapshot. The snapshot includes its physical stream `offset`; historical token deltas are already reduced into complete message parts.

## `client.agents.updates(...)`

```ts
updates(name: string, id: string, options: AgentConversationUpdateOptions): FlueEventStream<AgentConversationUpdate>;
```

Streams durable conversation updates strictly after the required `offset`. Initialize local state with `history()`, then apply updates with `reduceAgentConversationUpdate()`.

```ts
const snapshot = await client.agents.history('support', 'ticket-42');
let state = createAgentConversationState(snapshot);

for await (const update of client.agents.updates('support', 'ticket-42', {
  offset: snapshot.offset,
  live: 'sse',
})) {
  state = reduceAgentConversationUpdate(state, update);
}
```

## `client.agents.activity(...)`

```ts
activity(name: string, id: string, options: AgentConversationActivityOptions): FlueEventStream<AgentConversationActivity>;
```

Reads raw canonical activity for diagnostics. Use `history()` and `updates()` for application conversation state.
