---
title: client.agents
description: Invoke persistent agent instances and stream their events.
---

Direct agent APIs interact with persistent agent instances. They use an agent name and instance id. Each agent instance is a single conversation. Direct agent interactions do not create workflow runs and do not emit `runId`.

## `client.agents.invoke(...)`

```ts
invoke(name: string, id: string, options: AgentInvokeOptions): Promise<SyncInvokeResult>;
```

Sends one prompt to a persistent agent instance and waits for the terminal result.

### `AgentInvokeOptions`

| Field     | Type                 | Description                        |
| --------- | -------------------- | ---------------------------------- |
| `payload` | `DirectAgentPayload` | Prompt payload.                    |
| `signal`  | `AbortSignal`        | Cancel the in-flight HTTP request. |

### `DirectAgentPayload`

| Field     | Type     | Description                        |
| --------- | -------- | ---------------------------------- |
| `message` | `string` | Prompt sent to the agent instance. |

### `SyncInvokeResult`

```ts
interface SyncInvokeResult {
  result: unknown;
}
```

## `client.agents.stream(...)`

```ts
stream(name: string, id: string, options?: FlueStreamOptions): FlueEventStream<FlueEvent>;
```

Streams events from an agent instance via the [Durable Streams](https://durablestreams.com) protocol. Returns an async iterable of typed `FlueEvent` objects.

Use `offset` to control where reading begins. Pass `"-1"` for full history, `"now"` for future events only, or an offset returned by a previous read to resume from that position.

```ts
for await (const event of client.agents.stream('support', 'ticket-42', {
  offset: '-1',
  live: true,
})) {
  console.log(event.type);
  if (event.type === 'idle') break;
}
```

See [`FlueStreamOptions`](/docs/sdk/runs/#fluestreamoptions) for available options.
