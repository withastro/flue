---
title: client.agents
description: Invoke persistent agent instances and stream their events.
---

Direct agent APIs interact with persistent agent instances. They use an agent name and instance id. Each agent instance is a single conversation. Direct agent interactions do not create workflow runs and do not emit `runId`.

## `client.agents.prompt(...)`

```ts
prompt(name: string, id: string, options: AgentPromptOptions): Promise<AgentPromptResult>;
```

Sends one prompt to a persistent agent instance and waits for the terminal result.

### `AgentPromptOptions`

| Field     | Type          | Description                        |
| --------- | ------------- | ---------------------------------- |
| `message` | `string`      | Prompt sent to the agent instance. |
| `signal`  | `AbortSignal` | Cancel the in-flight HTTP request. |

### `AgentPromptResult`

```ts
interface AgentPromptResult {
  result: unknown;
  streamUrl: string;
  offset: string;
}
```

## `client.agents.send(...)`

```ts
send(name: string, id: string, options: AgentPromptOptions): Promise<{ streamUrl: string; offset: string }>;
```

Starts one prompt without waiting for completion. Use the returned `offset` with `agents.stream()` to read exactly that prompt's events.

## `client.agents.stream(...)`

```ts
stream(name: string, id: string, options?: FlueStreamOptions): FlueEventStream<AttachedAgentEvent>;
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
