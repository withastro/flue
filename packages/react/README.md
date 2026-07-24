# `@flue/react`

React hooks for live Flue agent conversations. `@flue/react` manages UI state; `@flue/sdk` handles HTTP and Durable Streams transport.

```sh
pnpm add @flue/react @flue/sdk
```

Requires React 18 or later. For examples, see the [React guide](https://flueframework.com/docs/guide/react/).

## `useFlueAgent()`

A hook observes one agent conversation, addressed by URL: wherever the application's `app.ts` mounts the agent's routes (`app.route('/agents/triage', createAgentRouter(Triage))`) plus a caller-chosen conversation id. Starting a new conversation is rendering the hook with a fresh id appended to the mount URL.

```tsx
import { useFlueAgent } from '@flue/react';

function Chat({ conversationId }: { conversationId: string }) {
  const agent = useFlueAgent({ url: `/api/agents/triage/${conversationId}` });
  // agent.messages, agent.status, agent.sendMessage(...)
}
```

```ts
function useFlueAgent(options?: UseFlueAgentOptions): UseFlueAgentResult;

interface UseFlueAgentOptions {
  url?: string;
  client?: FlueClient;
  live?: 'sse' | 'long-poll';
}
```

| Option   | Description                                                                                                                                                                    |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `url`    | Conversation URL (agent mount URL + conversation id). Relative URLs resolve against the browser origin. Omit (together with `client`) to keep the hook dormant.                |
| `client` | Pre-configured `createFlueClient({ url, headers, token, fetch })` for custom auth or transport. Takes precedence over `url`. Memoize it — a new instance replaces the session. |
| `live`   | Live stream mode. Defaults to `'sse'`; use `'long-poll'` to disable SSE.                                                                                                       |

```ts
interface UseFlueAgentResult {
  messages: FlueConversationMessage[];
  status: AgentStatus;
  historyReady: boolean;
  error: Error | undefined;
  failedSends: FailedSend[];
  sendMessage(message: string, options?: SendMessageOptions): Promise<void>;
  refresh(): void;
}

interface SendMessageOptions {
  images?: DeliveredAttachment[];
}

type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';
```

| Status       | Meaning                                                                  |
| ------------ | ------------------------------------------------------------------------ |
| `idle`       | No local prompt is active, or the hook is dormant.                       |
| `connecting` | Initial connection or retry. `error` holds the latest retryable failure. |
| `submitted`  | A prompt is being admitted or awaits attributable assistant activity.    |
| `streaming`  | Assistant activity for this client's submission is arriving.             |
| `error`      | Prompt admission, a submission, or stream observation failed.            |

### `sendMessage()`

Adds an optimistic user message, delivers it through the conversation client, and resolves when the server admits the prompt (202 admission). It does not wait for generation. If admission fails, the optimistic message is retained and surfaced through `failedSends` (with `status: 'error'`) so a UI can offer retry, and the promise rejects. The canonical user message later re-keys to the optimistic row's id, so the rendered row is stable across the optimistic→confirmed swap. Concurrent sends use the runtime's per-conversation queue. Calling it on a dormant hook rejects.

### `refresh()`

Re-runs the conversation's history catch-up and resumes live updates. A conversation that does not exist yet reports as empty (`historyReady` with no messages); when its creation is triggered out-of-band (a webhook, queue worker, or server-side wakeup), call `refresh()` on whatever schedule the application chooses.

### History and live updates

The hook loads the materialized conversation snapshot before publishing it, sets `historyReady` to `true`, and then follows live updates from the exact snapshot checkpoint. Consumers receive one coherent initial transcript. Transient stream failures retry with capped exponential backoff from a fresh snapshot; redelivered chunks are deduped, so at-least-once transports never double-apply streaming deltas.

The hook has no `stop()` method because ending browser observation does not cancel server work.

## Messages

Messages are the SDK's materialized conversation shape (`FlueConversationMessage` with `FlueConversationPart[]`): `text` and `reasoning` parts carry a `streaming | done` state, `dynamic-tool` parts progress from `input-available` to `output-available`/`output-error`, and `file` parts carry a ready-to-use `url` (a hosted attachment URL once durably recorded; a local `data:` preview on an optimistic echo). Message `metadata` carries the server-authored `timestamp`, token `usage`, and `model` identity when known.

## SSR and lifecycle

Hooks return empty, idle server snapshots and connect only after React commits in the browser. React Strict Mode effect replay is supported.

Changing the `url`, `client`, or `live` option replaces the current session. Unmounting stops local observation but not server-side work.

## Re-exported types

`@flue/react` re-exports these SDK types: `DeliveredAttachment`, `FlueClient`, `FlueConversationMessage`, `FlueConversationPart`, `PromptUsage`.
