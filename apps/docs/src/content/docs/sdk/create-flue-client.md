---
title: createFlueClient(...)
description: Construct a Flue Agent SDK client, covering URL semantics, the fetch override, headers, and token.
lastReviewedAt: 2026-07-21
---

```ts
import { createFlueClient } from '@flue/sdk';

const conversation = createFlueClient({
  url: 'https://example.com/agents/triage/ticket-42',
  token: process.env.FLUE_TOKEN,
});
```

## `createFlueClient()`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for one agent conversation of a deployed Flue application. The framework does not know where an application mounts its agents. Only the application's [route map](/docs/guide/routing/) (`app.ts`) knows. So a client addresses exactly one conversation by a URL made of the path where the agent's router (`createAgentRouter(...)`) is mounted plus a caller-chosen conversation id. To start a new conversation, construct a client with a fresh id appended to the mount URL. The caller chooses ids, and the first admitted send creates the conversation. There is no deployment-wide client and no name/id addressing.

Construction is synchronous and makes no network requests. It resolves the URL and returns the [`FlueClient`](/docs/sdk/flue-client/). Construction does not verify that the URL reaches a mounted agent or that the conversation exists. The first request does, and rejects with [`FlueApiError`](/docs/sdk/errors/#flueapierror) on a non-2xx response. The one construction-time failure is a relative `url` outside a browser, which throws a `TypeError`.

## `CreateFlueClientOptions`

```ts
type CreateFlueClientOptions = HttpClientOptions;

interface HttpClientOptions {
  url: string;
  fetch?: typeof fetch;
  headers?: RequestHeaders;
  token?: string;
}
```

`CreateFlueClientOptions` is an alias of `HttpClientOptions`. Both names are exported.

| Field     | Description                                                                                                                                                                                                                                                                                                                                                                                  |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`     | URL of one agent conversation: the URL where the agent's routes are mounted plus the conversation id (`https://host/agents/triage/ticket-42`). Trailing slashes are stripped. In a browser, a relative URL (`/api/agents/triage/ticket-42`) resolves against `location.origin`. Outside a browser, a relative URL throws `TypeError: relative url requires a browser; pass an absolute URL`. |
| `fetch`   | HTTP implementation used for every request the client makes, including the stream reads behind `wait()` and `observe()`. Defaults to the global `fetch` bound to `globalThis` (so the browser's "Illegal invocation" receiver check cannot trip). A caller-supplied function is used as-is. Bind it yourself if it is a method of another object.                                            |
| `headers` | Headers merged into every request. Merged after the `token`-derived header, so a `headers` entry named `authorization` wins over `token`.                                                                                                                                                                                                                                                    |
| `token`   | Bearer token, sent as `authorization: Bearer <token>` on every request.                                                                                                                                                                                                                                                                                                                      |

The options carry no retry or timeout configuration. Each JSON request (`send()`, `abort()`, `history()`) is a single fetch, cancelled per call with `AbortSignal`. The reconnecting stream reads take `backoffOptions` per call on [`wait()`](/docs/sdk/flue-client/#wait) and [`observe()`](/docs/sdk/flue-client/#observe).

### Service bindings and other custom transports

Because every request, including streaming reads, travels through the `fetch` option, the client works over any fetch-shaped transport. On Cloudflare, point it at a [service binding](/docs/guide/cloudflare-target/#calling-a-private-agent-over-a-service-binding) to reach a private Worker. The `url` host is never dialed, so any placeholder origin works as long as the URL is absolute:

```ts
const conversation = createFlueClient({
  url: 'https://agent.internal/agents/support/ticket-42',
  fetch: (input, init) => env.AGENT_APP.fetch(new Request(input, init)),
});
```

The same override can inject a test transport. Pass `fetch` a function that returns canned `Response` objects, and the client makes no network calls.

## `RequestHeaders`

```ts
type RequestHeaders =
  Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
```

Static headers, or a function that resolves headers for each HTTP request. The function form (sync or async) is re-evaluated once per JSON request and once per stream connection and reconnection, so an async factory can refresh a short-lived token and every retry picks up the fresh value.

Headers apply only to requests the client itself makes. [`attachmentUrl()`](/docs/sdk/flue-client/#attachmenturl) returns a plain URL string. A request you make with it (an `<img>` load, a manual fetch) carries none of these headers.
