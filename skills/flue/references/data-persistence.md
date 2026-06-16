# Data Persistence

Use this for `db.ts`, adapter choice, and what Flue stores.

## Node Persistence

Add source-root `db.ts` when Node state should survive restart:

```ts
import { sqlite } from '@flue/runtime/node';

export default sqlite('./data/flue.db');
```

| Adapter | Use |
| --- | --- |
| No `db.ts` | In-memory SQLite; state lost on process exit. |
| `sqlite('./file.db')` | Local development, single-host deployment, small services. |
| `@flue/postgres` | Multi-replica Node deployment or host replacement recovery. |
| Custom `PersistenceAdapter` | Another database backend or hosting strategy. |

Postgres `migrate()` runs automatically when the generated Node server starts.

## Cloudflare Persistence

- No `db.ts`.
- Generated agent and workflow Durable Objects use SQLite automatically.
- Run indexing lives in generated `FlueRegistry`.
- Cloudflare build rejects a source-root `db.ts`.

## Stored Vs Not Stored

| Stored by Flue | Not stored by Flue |
| --- | --- |
| Agent session messages and compaction state | Sandbox files and installed dependencies |
| Accepted direct prompts and `dispatch(...)` submissions | External API side effects |
| Workflow-run records and persisted events | Business data unless application tools store it |
| Run indexing for `/runs` and `listRuns()` | Provider credentials or secrets |

## Design Checks

- Keep customer records, payments, tickets, and durable business entities in the application database.
- Treat external effects as application-owned and make them idempotent when provider retries are possible.
- Do not assume persisted session history means workspace files are durable.
- Do not assume a durable sandbox preserves conversation state.

