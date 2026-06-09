---
title: client.agents
description: Invoke persistent agent instances over HTTP or WebSockets.
lastReviewedAt: 2026-06-02
---

Direct agent APIs interact with persistent agent instances. They use an agent name and instance id. Each agent instance is a single conversation. Direct agent interactions do not create workflow runs and do not emit `runId`.

## `client.agents.invoke(...)`

```ts
invoke(name: string, id: string, options: AgentSyncInvokeOptions): Promise<{ result: unknown }>;

invoke(name: string, id: string, options: AgentStreamInvokeOptions): AsyncIterable<AttachedAgentEvent>;
```

Sends one prompt to a persistent agent instance. Use `mode: 'sync'` for the terminal result or `mode: 'stream'` to consume attached-agent events. `AgentInvokeOptions` is the union of `AgentSyncInvokeOptions` and `AgentStreamInvokeOptions` for wrappers that forward either mode.

| Field     | Type                 | Default | Description                        |
| --------- | -------------------- | ------- | ---------------------------------- |
| `mode`    | `'sync' \| 'stream'` | —       | Select the response mode.          |
| `payload` | `DirectAgentPayload` | —       | Prompt payload.                    |
| `signal`  | `AbortSignal`        | —       | Cancel the in-flight HTTP request. |

### `DirectAgentPayload`

| Field     | Type     | Default | Description                        |
| --------- | -------- | ------- | ---------------------------------- |
| `message` | `string` | —       | Prompt sent to the agent instance. |

## `client.agents.connect(...)`

```ts
connect(name: string, id: string): AgentSocket;
```

Opens a reusable WebSocket connection to an agent instance.

### `AgentSocket`

```ts
interface AgentSocket {
  readonly ready: Promise<void>;
  prompt(message: string, options?: AgentSocketPromptOptions): Promise<AgentSocketInvokeResult>;
  ping(): Promise<void>;
  onEvent(listener: AgentSocketEventListener): () => void;
  close(code?: number, reason?: string): void;
}
```

`ready` resolves after the server accepts the connection. Sequential `prompt()` calls may reuse the socket. `onEvent()` subscribes to prompt events and returns an unsubscribe function. `close()` rejects pending work.

### `AgentSocketPromptOptions`

No options are currently accepted. This type exists for future extensibility.

### `AgentSocketInvokeResult`

```ts
interface AgentSocketInvokeResult {
  result: unknown;
}
```
