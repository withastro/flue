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
  settlements: FlueConversationSettlement[];
  sendMessage(message: string, options?: SendMessageOptions): Promise<AgentSendResult>;
  refresh(): void;
}

/** Every option `client.send()` accepts except `message` (see below), plus `images`. */
type SendMessageOptions = Omit<AgentPromptOptions, 'message'> & {
  images?: DeliveredAttachment[];
};

type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';
```

| Status       | Meaning                                                                                                                                                                                                               |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `idle`       | None of the conditions below hold — no unsettled submission, no in-flight local prompt, no retained failure. The hook is also `idle` when dormant.                                                                    |
| `connecting` | Initial connection or retry. `error` holds the latest retryable failure.                                                                                                                                              |
| `submitted`  | A local prompt is being admitted or awaits its activity appearing in the observed conversation.                                                                                                                       |
| `streaming`  | An unsettled submission is active in the observed conversation (including out-of-band work: webhooks, dispatches, other clients), or a locally-admitted submission that has not yet settled is recollected in memory. |
| `error`      | The latest settled _local_ submission failed, or a failed send is retained.                                                                                                                                           |

`status` is the first of the following that applies, top to bottom:

1. `error` — the latest settled _local_ submission failed.
2. `streaming` — assistant text or reasoning is actively streaming.
3. `submitted` — a local prompt is being admitted or awaits attributable activity.
4. `streaming` — an unsettled submission is active in the observed conversation (including out-of-band work: webhooks, dispatches, other clients), or a locally-admitted submission that has not yet settled is recollected in memory.
5. `error` — a failed send is retained.
6. `idle` — none of the above.

The local recollection is the exception to the conversation-scoped reading: a locally-admitted submission that has not yet settled keeps `status` at `streaming` across an empty or `absent` observation until the submission settles or the observation reflects it. Separately from this precedence, a fatal stream-observation failure reports `error`, and an in-flight initial read or retry reports `connecting` (with `error` holding the latest retryable failure) where the precedence above would otherwise be `idle`.

`settlements` mirrors the observed conversation's terminal submission outcomes (`FlueConversationSettlement[]`), so application code can correlate a `submissionId` with its `completed`/`failed`/`aborted` outcome. Exposing it is additive — it does not change the `status`/`error` derivation above, which already reads the same observed settlements internally.

### `sendMessage()`

Adds an optimistic user message, delivers it through the conversation client, and resolves with the admission receipt (`AgentSendResult`) when the server admits the prompt (202 admission). It does not wait for generation. The receipt carries the `submissionId` to correlate with `settlements`; on a replay it reports `deduplicated: true`. If admission fails, the optimistic message is retained and surfaced through `failedSends` (with `status: 'error'`) so a UI can offer retry, and the promise rejects. The canonical user message later re-keys to the optimistic row's id, so the rendered row is stable across the optimistic→confirmed swap. Concurrent sends use the runtime's per-conversation queue. Calling it on a dormant hook rejects.

Because `SendMessageOptions` passes through everything `client.send()` accepts (minus the message itself), you can use an `idempotencyKey` to make a retry safe: a network failure does not prove the server rejected the prompt, so retry with the same key converges on the original submission instead of admitting a duplicate — generate and persist the key _before_ calling `sendMessage` (do not derive it from session-local state; it must survive unmounts and reloads to be useful).

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

`@flue/react` re-exports these SDK types: `DeliveredAttachment`, `FlueClient`, `FlueConversationMessage`, `FlueConversationPart`, `FlueConversationSettlement`, `PromptUsage`.
