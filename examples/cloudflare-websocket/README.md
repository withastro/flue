# Cloudflare WebSocket Example

This example is the live Cloudflare WebSocket fixture. It mounts `flue()` below `/api`, rejects socket upgrades without its test token in `src/app.ts`, exposes a Durable Object-backed `chat` agent, and exposes a model-free `live-smoke` workflow for integration testing.

## Live smoke test

From the repository root:

```bash
vp run @flue/runtime#build @flue/sdk#build @flue/cli#build
pnpm exec bgproc start -n flue-cf-ws-live --wait-for-port 10 --force -- \
  pnpm --dir ./examples/cloudflare-websocket exec flue dev --target cloudflare --port 3584
FLUE_WS_BASE_URL=http://localhost:3584 \
  pnpm --dir ./examples/cloudflare-websocket run test:live
pnpm exec bgproc stop -n flue-cf-ws-live
```

The live client verifies that unauthenticated agent and workflow upgrades are rejected, an authenticated agent socket is accepted and responds to protocol-level `ping`, and an authenticated workflow socket invokes its handler, returns a result, and closes normally. The smoke deliberately does not issue an agent prompt because that would require Workers AI inference; the workflow provides deterministic operation/result coverage without an API key or model cost.

## Agent connection

The `chat` agent uses Workers AI for real prompts. Because this fixture uses a custom `/api` mount and a test query-token middleware, configure the SDK public mount URL and handshake URL explicitly:

```ts
import { createFlueClient } from '@flue/sdk';

const client = createFlueClient({
  baseUrl: 'http://localhost:3584/api',
  websocketUrl: (url) => {
    url.searchParams.set('token', 'live-test');
    return url;
  },
});

const chat = client.agents.connect('chat', 'customer-123');
await chat.ready;
```

The stable instance id selects the same Durable Object-backed agent scope. The generated Cloudflare transport accepts hibernation-compatible sockets inside that owning Durable Object. HTTP SDK `token` and `headers` settings do not apply automatically to the WebSocket handshake.

Deploy with:

```bash
pnpm exec flue build --target cloudflare
pnpm exec wrangler deploy
```

Replace the test query-token middleware with application authentication before deploying this example publicly.
