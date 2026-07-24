---
title: Flue Agent SDK
description: The Flue Agent SDK (@flue/sdk) — installation, a minimal round trip, the HTTP surface it wraps, and a map of the SDK reference pages.
lastReviewedAt: 2026-07-21
---

The **Flue Agent SDK** (`@flue/sdk`) is the TypeScript client for one agent conversation of a deployed Flue application. A client wraps a single **conversation URL** — the path where the agent's router (`createAgentRouter(...)`) is [mounted](/docs/guide/routing/#mounting-an-agent) plus a caller-chosen conversation id — and exposes typed methods over the HTTP routes that URL serves: admit a message, await its settlement, read or observe the materialized conversation, abort in-flight work, and resolve attachment bytes.

The package is ESM-only, runs anywhere `fetch` is available (browsers, Node.js, edge runtimes), and has one dependency, `@durable-streams/client`, which provides the reconnecting stream transport under `wait()` and `observe()`.

## Installation

```sh
npm install @flue/sdk
```

## A minimal round trip

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/support/ticket-8472',
  token: process.env.FLUE_TOKEN,
});

// Admit one message. The server responds 202 before the agent runs.
const admission = await conversation.send({
  message: { kind: 'user', body: 'Summarize the open issues in my case.' },
});

// Await the submission's settlement and read its reply.
// Throws FlueExecutionError when the run fails or is aborted.
const reply = await conversation.read(admission);
```

Sends are fire-and-forget admissions — the agent's response lands in the conversation, and `read()` is the composed round trip that waits for the submission to settle and reads its reply back out. The primitives beneath it are also public: `wait()` resolves on settlement without fetching the reply (for callers that only need the outcome), `history()` reads one materialized snapshot, `observe()` maintains a live view across catch-up and live updates, and the pure `readSubmissionReply()` helper extracts a submission's reply from either — including the coalesced reply when the send joined a busy response. All of them are documented on the [`FlueClient`](/docs/sdk/flue-client/) page.

## One conversation per client

There is no deployment-wide client and no agent-name addressing. The framework does not know where an application mounts its agents — the application's route map (`app.ts`) does — so a client addresses exactly one conversation by URL. Consequences:

- Starting a new conversation is constructing a client with a fresh id appended to the mount URL. The conversation itself is created on the first message it receives; `createFlueClient()` performs no I/O.
- There is no API to enumerate conversations, look up agents by name, or delete a conversation. Those are application concerns behind application routes.
- Auth is whatever the application's routes require: the client attaches a bearer `token` or arbitrary `headers` to every request, including stream reconnections. Construction options are documented under [`CreateFlueClientOptions`](/docs/sdk/create-flue-client/#createflueclientoptions).

## The HTTP surface it wraps

Every client method is a typed wrapper over one route of the conversation URL (see [Routing — The conversation URL](/docs/guide/routing/#the-conversation-url)):

- `send()` — `POST <url>`; the body is the same `DeliveredMessage` shape a server-side `dispatch(...)` admits, optionally with `initialData` and a `uid` send condition.
- `read()` — `wait()`'s stream follow, then one `history()` read to return the submission's reply.
- `wait()` — reads the `GET <url>?view=updates` stream from the admission's offset until the submission's `submission-settled` chunk arrives.
- `history()` — `GET <url>?view=history`; one materialized snapshot.
- `observe()` — `history()` to hydrate, then the `updates` stream to stay live, with reconnection, rehydration, and duplicate-chunk suppression handled internally.
- `abort()` — `POST <url>/abort`.
- `attachmentUrl()` — resolves `<url>/attachments/<attachmentId>` for one `file` part's bytes.

Any HTTP client can call these routes directly — the wire protocol is documented in the [Streaming Protocol](/docs/reference/streaming-protocol/) reference. What the SDK adds is the typed contract plus the stream mechanics you would otherwise reimplement: offset-based resume, reconnection backoff, per-request header resolution, and at-least-once redelivery dedup.

## Relationship to `@flue/react` and `@flue/runtime`

- [`useFlueAgent()`](/docs/guide/react/) from `@flue/react` is built on this package: it constructs a `createFlueClient(...)` from its `url` option (or accepts a pre-configured client for custom headers, auth, or fetch behavior) and reduces the client's `observe()` output into React state.
- Inside a Flue server process, HTTP is unnecessary: `init()` and `dispatch()` from `@flue/runtime` address agents directly (see [Building agents](/docs/guide/building-agents/)). The SDK is for code outside the process — browsers, scripts, CI, other services — reaching a deployed agent over its HTTP surface.

## Pages in this section

- [createFlueClient(...)](/docs/sdk/create-flue-client/) — constructing a client (`CreateFlueClientOptions`: `url`, `fetch`, `headers`, `token`), URL resolution, and custom transports.
- [FlueClient](/docs/sdk/flue-client/) — the conversation methods — `send()`, `wait()`, `abort()`, `history()`, `observe()`, and `attachmentUrl()` — with their option, result, and materialized conversation state types.
- [Events and records](/docs/sdk/events/) — the `updates` wire union (`ConversationStreamChunk`), the `FlueEventStream` iteration surface, and offset/redelivery semantics.
- [Errors](/docs/sdk/errors/) — `FlueApiError` (failed HTTP requests), `FlueExecutionError` (failed or aborted settlements), the documented server error envelope, and the re-exported `@durable-streams/client` stream errors.
