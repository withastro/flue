---
title: client.admin
description: Read agent metadata and workflow-run records from the admin routes.
lastReviewedAt: 2026-06-02
---

Admin APIs use the origin-relative read-only mount path configured with `adminBasePath`, independently from the public `baseUrl` pathname. This option only tells the SDK where an already-mounted `admin()` sub-app lives. The application must [mount `admin()` explicitly and protect that mount with application-owned authorization](/docs/api/routing-api/#admin).

## `client.admin.agents.list()`

```ts
list(): Promise<{ items: AgentManifestEntry[] }>;
```

Lists all built agents and their transport metadata. This response is intentionally unpaginated.

## `client.admin.runs.list(...)`

```ts
list(options?: ListRunsOptions): Promise<ListResponse<RunPointer>>;
```

Lists workflow-run summaries. Direct agent interactions and dispatches are not included.

### `ListRunsOptions`

| Field          | Type                                   | Default | Description                                |
| -------------- | -------------------------------------- | ------- | ------------------------------------------ |
| `cursor`       | `string`                               | —       | Resume after this pagination cursor.       |
| `limit`        | `number`                               | —       | Maximum runs to return; accepts `1..1000`. |
| `status`       | `'active' \| 'completed' \| 'errored'` | —       | Select workflow-run statuses.              |
| `workflowName` | `string`                               | —       | Select one workflow name.                  |

To retrieve one workflow-run record, use [`client.runs.get()`](/sdk/runs/) — it reads from the same admin mount path.
