---
title: React
description: Build React interfaces for live agent conversations.
lastReviewedAt: 2026-07-21
---

`@flue/react` turns Flue's durable conversation streams into live React state. `useFlueAgent()` observes one agent conversation and sends messages into it. HTTP requests, authentication, and stream transport remain in `@flue/sdk`.

## Set up React

```sh
pnpm add @flue/react @flue/sdk
```

No provider or app-level setup is required. A hook addresses one conversation by URL: wherever your application's `app.ts` mounts the agent's routes (`app.route('/agents/support-assistant', createAgentRouter(SupportAssistant))`) plus a caller-chosen conversation id. Starting a new conversation is rendering the hook with a fresh id appended to the mount URL.

The agent must be mounted in `app.ts` for the browser to reach it, and the middleware you attach at that mount decides who may access which conversation. See [Routing](/docs/guide/routing/) to mount and protect the agent's routes, including for cross-origin applications.

## Build an agent conversation

The hook reconstructs the conversation's transcript from durable events, then follows new events:

```tsx title="src/Chat.tsx"
import { useFlueAgent } from '@flue/react';
import { useState } from 'react';

export function Chat({ conversationId }: { conversationId: string }) {
  const [input, setInput] = useState('');
  const agent = useFlueAgent({
    url: `/api/agents/support-assistant/${conversationId}`,
  });

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const message = input.trim();
    if (!message) return;

    setInput('');
    await agent.sendMessage(message);
  }

  return (
    <section>
      <div aria-live="polite">
        {agent.messages.map((message) => (
          <article key={message.id}>
            <strong>{message.role}</strong>
            {message.parts.map((part) =>
              part.type === 'text' ? <p key={part.text}>{part.text}</p> : null,
            )}
          </article>
        ))}
      </div>

      <form onSubmit={submit}>
        <input value={input} onChange={(event) => setInput(event.target.value)} />
        <button disabled={!input.trim()} type="submit">
          Send
        </button>
      </form>
    </section>
  );
}
```

The `url` here assumes `app.ts` mounted the agent at `/api/agents/support-assistant`; use whatever URL your route map chose. Relative URLs resolve against the browser origin.

`sendMessage()` adds the user message immediately and resolves when the server admits the prompt, not when generation finishes. The stream then reconciles that optimistic message with its durable copy without changing its transcript position. Use `status` to distinguish connection, submission, streaming, and error states. `historyReady` becomes `true` once the requested durable history has loaded as one coherent snapshot; it remains `true` through later live reconnects.

Messages are Flue-owned `FlueConversationMessage` values with a parts-based shape: `text`, `reasoning`, `dynamic-tool`, and `file`. Validated structured tool output is preserved on the `dynamic-tool` part's `output`, so applications can render custom tool interfaces without a separate data-event channel. These are Flue's own types — they are not AI SDK types, and `@flue/react` neither depends on `ai` at runtime nor implements its transport protocol. Durable `file` parts carry a ready-to-use `url` for attachment bytes (served through the agent router's attachments endpoint); optimistic uploads carry a local `data:` preview.

The hook uses the Flue Agent SDK's materialized `observe()` layer: it loads the complete canonical snapshot, publishes it atomically in durable order, and continues from that exact checkpoint through reconnects and canonical resets. Consumers do not need to coordinate the snapshot and live updates or sort `messages`. Live updates default to SSE, falling back to Durable Streams long-polling (`live: 'long-poll'` selects it explicitly). For a single point-in-time read with no live updates, use the SDK client's `history()` directly instead. Partial text and reasoning are best-effort while streaming; the completed canonical assistant message is authoritative.

To observe a conversation that may be created out-of-band after mount — by a server-side wakeup, queue worker, or webhook — call `refresh()` to re-run history catch-up and resume live updates. Deciding when to re-check is the application's responsibility.

## Authentication and custom clients

For custom headers, a bearer token, or custom `fetch` behavior, create the conversation client yourself and pass it to the hook. Memoize it — a new client instance replaces the session:

```tsx
import { useFlueAgent } from '@flue/react';
import { createFlueClient } from '@flue/sdk';
import { useMemo } from 'react';

function Chat({ conversationId, token }: { conversationId: string; token: string }) {
  const client = useMemo(
    () =>
      createFlueClient({
        url: `/api/agents/support-assistant/${conversationId}`,
        token,
      }),
    [conversationId, token],
  );
  const agent = useFlueAgent({ client });
  // ...
}
```

## Rendering and deferred identity

During server rendering, the hook returns empty, idle state and opens no connections. A relative `url` such as `/api/...` resolves against the browser origin, so the server render stays dormant and the hook connects after hydration. An omitted `url` (and `client`) leaves the hook dormant while routing or application data resolves the conversation identity.

## API reference

See the [`@flue/react` package README](https://github.com/withastro/flue/tree/main/packages/react#readme) for complete options, result types, statuses, and message-part types. A complete runnable chat UI is available in [`examples/react-chat`](https://github.com/withastro/flue/tree/main/examples/react-chat).
