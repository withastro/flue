# `@flue/react`

React hooks for live Flue agent conversations and workflow runs. `@flue/react` manages UI state; `@flue/sdk` handles HTTP and Durable Streams transport.

```sh
pnpm add @flue/react @flue/sdk
```

Requires React 18 or later. For examples, see the [React guide](https://flueframework.com/docs/guide/react/). Relative `baseUrl` values such as `/api` require a browser; use an absolute URL when creating the client during SSR.

## Setup

```tsx
import { FlueProvider } from '@flue/react';
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({ baseUrl: '/api' });

export function Root() {
  return (
    <FlueProvider client={client}>
      <App />
    </FlueProvider>
  );
}
```

### `FlueProvider`

```ts
interface FlueProviderProps {
  client: FlueClient;
  children?: ReactNode;
}
```

Provides an application-created SDK client to descendant hooks. Configure authentication, headers, and custom `fetch` behavior on that client.

### `useFlueClient()`

```ts
function useFlueClient(): FlueClient;
```

Returns the nearest provider's client and throws if no provider exists. The hooks also accept a `client` option instead of a provider; a client is required even while a hook is dormant.

## `useFlueAgent()`

```ts
function useFlueAgent(options: UseFlueAgentOptions): UseFlueAgentResult;

interface UseFlueAgentOptions {
  name: string;
  id?: string;
  history?: number | 'all';
  client?: FlueClient;
}
```

Connects to one persistent agent instance, reconstructs its transcript, and follows new events.

| Option | Description |
| --- | --- |
| `name` | Agent module name. |
| `id` | Agent instance ID. Omit to keep the hook dormant. |
| `history` | Positive integer event limit. Defaults to `100`; use `'all'` for full history. |
| `client` | SDK client override. |

```ts
interface UseFlueAgentResult {
  messages: UIMessage[];
  status: AgentStatus;
  error: Error | undefined;
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
}

interface SendMessageOptions {
  images?: AgentPromptImage[];
}

type AgentStatus =
  | 'idle'
  | 'connecting'
  | 'submitted'
  | 'streaming'
  | 'error';
```

| Status | Meaning |
| --- | --- |
| `idle` | No local prompt is active, or a new instance has no stream. |
| `connecting` | Initial connection or retry. `error` holds the latest retryable failure. |
| `submitted` | A prompt is being admitted or awaits attributable assistant activity. |
| `streaming` | Assistant activity for this client's submission is arriving. |
| `error` | Prompt admission or stream observation failed terminally. |

### `sendMessage()`

Adds an optimistic user message, calls `client.agents.send()`, and resolves when the server admits the prompt. It does not wait for generation. If admission fails, the hook removes the optimistic message, sets `error`, and rejects the promise. Calling it without an `id` rejects.

The admission receipt reconciles the optimistic message with its durable stream copy. Concurrent sends use the runtime's per-session queue.

A new agent instance has no stream until its first prompt is admitted. The hook treats the initial `404` as an empty conversation and attaches after its first successful send. Transient failures retry from the delivered checkpoint with capped exponential backoff, and `sendMessage()` wakes a pending retry.

The hook has no `stop()` method because ending browser observation does not cancel server work.

## Messages

`UIMessage` mirrors the AI SDK v5 data shape without a runtime dependency on `ai`. This compatibility does not include the AI SDK transport protocol.

```ts
interface UIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  metadata?: {
    usage?: PromptUsage;
    model?: { provider: string; id: string };
    [key: string]: unknown;
  };
  parts: UIMessagePart[];
}

type UIMessagePart =
  | { type: 'text'; text: string; state?: 'streaming' | 'done' }
  | { type: 'reasoning'; text: string; state?: 'streaming' | 'done' }
  | {
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: 'input-available';
      input: unknown;
    }
  | {
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: 'output-available';
      input: unknown;
      output: unknown;
    }
  | {
      type: 'dynamic-tool';
      toolName: string;
      toolCallId: string;
      state: 'output-error';
      input: unknown;
      errorText: string;
    }
  | { type: 'file'; mediaType: string; url: string };
```

Message snapshots are authoritative for text and reasoning. Tool calls progress from input to output or error; tool input arrives complete, so there is no `input-streaming` state.

Durable events omit image bytes, so replayed file parts contain a non-renderable redaction sentinel in `url`. Images sent by the current client retain their usable data URLs when reconciled. Message IDs remain stable across replay: assistant IDs derive from `turnId`, and direct user IDs from `submissionId`.

## `useFlueWorkflow()`

```ts
function useFlueWorkflow(options: UseFlueWorkflowOptions): UseFlueWorkflowResult;

interface UseFlueWorkflowOptions {
  runId?: string;
  client?: FlueClient;
}
```

Replays and follows one workflow run. Invoke the workflow separately through `useFlueClient()` or another SDK client.

| Option | Description |
| --- | --- |
| `runId` | Workflow run ID. Omit to keep the hook dormant. |
| `client` | SDK client override. |

```ts
interface UseFlueWorkflowResult {
  events: FlueEvent[];
  logs: Extract<FlueEvent, { type: 'log' }>[];
  status: WorkflowStatus;
  result: unknown;
  error: unknown;
}

type WorkflowStatus =
  | 'idle'
  | 'connecting'
  | 'running'
  | 'completed'
  | 'errored'
  | 'disconnected';
```

The hook replays the complete bounded run stream. `events` is uncapped, `logs` contains its log events, and `result` and workflow errors come from `run_end`. A successful run without a result returns `null`.

| Status | Meaning |
| --- | --- |
| `idle` | No `runId` is present. |
| `connecting` | Initial connection or retry. `error` holds the latest retryable transport failure. |
| `running` | A `run_start` or `run_resume` event was observed. |
| `completed` | `run_end` reported success. |
| `errored` | `run_end` reported a workflow failure. |
| `disconnected` | Observation ended without `run_end` and will not retry. |

Transient failures remain `connecting` and retry from the durable checkpoint. `401`, `403`, `404`, and stream closure without `run_end` become `disconnected`. Completed and errored runs are terminal.

## SSR and lifecycle

Hooks return empty, idle server snapshots and connect only after React commits in the browser. React Strict Mode effect replay is supported.

Changing the client, agent name, agent ID, history, or workflow run ID replaces the current observer. Unmounting stops local observation but not server-side work.

## Re-exported types

`@flue/react` re-exports these SDK types:

- `AgentPromptImage`
- `AttachedAgentEvent`
- `FlueEvent`
- `PromptUsage`
