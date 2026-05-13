# @flue/sdk

Typed client scaffold for deployed Flue apps. The package is private for now and intentionally hand-written while the API surface is small.

## Usage

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'https://my-flue.example.com',
  headers: { authorization: 'Bearer token' },
});

const { result, runId } = await client.agents.invoke('hello', 'inst-1', {
  mode: 'sync',
  payload: { name: 'Ada' },
});

for await (const event of client.runs.stream(runId)) {
  console.log(event.type);
}

const active = await client.admin.runs.list({ status: 'active' });
```

## Structure

- `src/client.ts` exposes `createFlueClient()` with public and admin namespaces.
- `src/public/invoke.ts` implements the sync, webhook, and stream invocation modes.
- `src/public/stream.ts` implements reconnectable SSE run streams with `Last-Event-ID` resume.
- `src/types.ts` contains the SDK's wire types. The runtime still serves OpenAPI specs, but this first SDK pass does not generate code from them.
