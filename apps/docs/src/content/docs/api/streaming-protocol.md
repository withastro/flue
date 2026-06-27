---
title: Streaming Protocol
description: Reference for reading Flue agent conversations and workflow events over Durable Streams.
lastReviewedAt: 2026-06-26
---

Flue uses Durable Streams offsets for agent conversations and workflow-run events. SDK users should normally use `client.agents.observe()` for a materialized live conversation; `history()` and `updates()` expose the underlying snapshot/update boundary. Use `client.runs.stream()` and `client.runs.events()` for workflows.

## Stream routes

| Route | Purpose |
| --- | --- |
| `GET /agents/:name/:id?view=history` | Read one materialized agent conversation snapshot. |
| `GET /agents/:name/:id?view=updates&offset=...` | Read conversation updates after an offset. |
| `HEAD /agents/:name/:id` | Read agent stream metadata. |
| `GET /runs/:runId` | Read workflow-run events. |
| `HEAD /runs/:runId` | Read workflow-run stream metadata. |

A plain agent `GET` defaults to the history view. Agent views select the active `default` harness and session unless `conversationId`, `harness`, or `session` is provided.

## Agent history and updates

History returns one JSON snapshot after reducing the complete physical stream prefix. Its `offset` is the physical agent-instance tail, including records omitted from that conversation's projection.

Updates require `offset` and resume strictly after it. Use `live=long-poll` for one waitable read or `live=sse` for a continuous stream. Do not resume without retaining the projection state produced by the matching history snapshot; request fresh history when local state is unavailable.

The server reconstructs the canonical prefix through the supplied offset when an updates connection starts. The history response is an API-materialized projection, not a persisted conversation snapshot or replay cache, so reconnect cost grows with the physical agent-instance stream. Applications with very large streams should measure reconnect latency and avoid unnecessary reconnect loops.

Agent history and updates do not support `tail`. A suffix can omit message starts, branches, compaction state, or earlier deltas and cannot be reduced safely.

## Workflow reads

A plain workflow-run `GET` performs a catch-up read and returns a JSON array of versioned workflow events.

```http
GET /runs/run_01JX...?offset=-1
GET /runs/run_01JX...?offset=0000000000000000_0000000000000005&live=sse
```

Workflow-run streams retain `tail=N` for bounded event inspection.

## Offsets

Offsets are opaque resume-after tokens. Pass returned values back unchanged; do not parse or increment them.

One agent offset identifies one atomic canonical record batch. SDK stream checkpoints advance only after every public update derived from that batch has been delivered. A filtered batch may advance the offset without producing an update.

## Response headers

| Header | Meaning |
| --- | --- |
| `Stream-Next-Offset` | Offset to use for the next read. |
| `Stream-Up-To-Date` | `true` when the read reached the current tail. |
| `Stream-Closed` | Workflow event streams only: `true` when no more events can arrive. |
| `Stream-Cursor` | Cursor for long-poll continuation. |

Canonical agent conversation streams remain open and do not emit `Stream-Closed`. Catch-up responses use `Cache-Control: no-store`; SSE uses `Cache-Control: no-cache`.

## SSE framing

SSE responses contain:

- `event: data` frames with a JSON array of updates or events;
- `event: control` frames with `streamNextOffset` and optional `upToDate`; workflow event streams may also include `streamClosed`;
- heartbeat comments on idle connections.

Track `streamNextOffset` from control frames to resume after a disconnect.
