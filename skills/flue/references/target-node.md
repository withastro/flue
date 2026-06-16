# Node Target

Use this for Node.js build, runtime, sandbox, persistence, and restart behavior.

## Generated Server

- Build with `flue build --target node`.
- Start the generated server with `node dist/server.mjs`.
- Default production port is `3000`; set `PORT` to change it.
- `flue dev --target node` defaults to port `3583` and reloads on changes.
- Application dependencies are externalized. Deploy the built artifact alongside `node_modules` or inside a container that installs dependencies.

## State

| Setup | Behavior |
| --- | --- |
| No `db.ts` | Process-local in-memory SQLite; state disappears on exit. |
| `db.ts` with `sqlite('./file.db')` | State survives process restart on the same host. |
| `db.ts` with `@flue/postgres` | State can survive host replacement and be shared across replicas. |

With a durable adapter, direct prompts and `dispatch(...)` inputs enter the same SQL-backed per-instance queue and are processed in accepted order.

## Restart Caveat

Node does not have Cloudflare's automatic Durable Object wake or Fiber recovery. Startup reconciliation covers agent submissions. Interrupted workflow runs may remain listed as active with open streams even when their persisted events are readable. Use `flue logs --no-follow` to inspect persisted events after a crash.

## `local()` Sandbox

```ts
import { local } from '@flue/runtime/node';

export default createAgent(() => ({
  sandbox: local(),
}));
```

- Node is the only target with the built-in `local()` factory.
- It exposes the host filesystem and shell to model-directed work.
- It is useful for trusted development tools, CI tasks, and self-hosted automation.
- It is not an isolation boundary.
- Only shell-essential environment variables are exposed by default.
- Pass narrow `env` values explicitly; avoid `env: { ...process.env }` except in trusted environments.

## Environment

CLI commands load project `.env` during build/dev/run/connect. The built server does not load `.env`; provide environment variables when starting the process.

