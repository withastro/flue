---
title: createFlueClient(...)
description: Configure an SDK client for a deployed Flue application.
---

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://example.com/api',
  token: process.env.FLUE_TOKEN,
});
```

## `createFlueClient(...)`

```ts
function createFlueClient(options: CreateFlueClientOptions): FlueClient;
```

Creates a client for the public and read-only admin routes of a deployed Flue application.

## `CreateFlueClientOptions`

| Field           | Type             | Default        | Description                                                                |
| --------------- | ---------------- | -------------- | -------------------------------------------------------------------------- |
| `baseUrl`       | `string`         | —              | URL where the public `flue()` sub-app is mounted, including any pathname.  |
| `fetch`         | `typeof fetch`   | global `fetch` | Custom HTTP implementation. Also used for Durable Streams event streaming. |
| `headers`       | `RequestHeaders` | —              | Headers merged into each HTTP and stream request.                          |
| `token`         | `string`         | —              | Bearer token added to HTTP and stream requests.                            |
| `adminBasePath` | `string`         | `'/admin'`     | Origin-relative mount path for read-only admin routes.                     |

## `RequestHeaders`

```ts
type RequestHeaders =
  | Record<string, string>
  | (() => Record<string, string> | Promise<Record<string, string>>);
```

Use a function to resolve headers separately for each HTTP request and stream reconnection.
