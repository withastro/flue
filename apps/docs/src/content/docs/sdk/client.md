---
title: createFlueClient(...)
description: Configure an SDK client for a mounted Flue application.
lastReviewedAt: 2026-06-22
---

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://example.com/api',
  token: process.env.FLUE_TOKEN,
});
```

In a browser, `baseUrl` may be relative to `location.origin`. This is the usual same-origin setup:

```ts
const client = createFlueClient({ baseUrl: '/api' });
```

Outside a browser, `baseUrl` must be absolute; a relative value throws an error.

## `createFlueClient(...)`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for the HTTP routes of a mounted Flue application.

## `CreateFlueClientOptions`

| Field     | Type             | Default        | Description                                                                                                       |
| --------- | ---------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `baseUrl` | `string`         | —              | URL where the public `flue()` sub-app is mounted, including any pathname. Browser clients may use a relative URL. |
| `fetch`   | `typeof fetch`   | global `fetch` | Custom HTTP implementation. Also used for Durable Streams event streaming.                                        |
| `headers` | `RequestHeaders` | —              | Headers merged into each HTTP and stream request.                                                                 |
| `token`   | `string`         | —              | Bearer token added to HTTP and stream requests.                                                                   |

## `RequestHeaders`

```ts
type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
```

Use a function to resolve headers separately for each HTTP request and stream reconnection.

`fetch` may target an in-process Hono app instead of the network. This is useful for application-owned routes that call a private `flue()` mount; see [Call Flue from your own routes](/docs/guide/routing/#call-flue-from-your-own-routes).
