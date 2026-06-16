---
title: Streaming Protocol
description: Reference for reading Flue agent and workflow event streams over Durable Streams.
---

Flue implements the [Durable Streams](https://durablestreams.com) read protocol for agent-instance and workflow-run events. This page is for raw HTTP consumers. SDK users usually use `client.agents.stream()`, `client.runs.stream()`, or `client.runs.events()` instead.

## Stream routes

| Route                    | Purpose                                    |
| ------------------------ | ------------------------------------------ |
| `GET /agents/:name/:id`  | Read one agent instance stream.            |
| `HEAD /agents/:name/:id` | Read agent stream metadata without a body. |
| `GET /runs/:runId`       | Read one workflow-run stream.              |
| `HEAD /runs/:runId`      | Read workflow-run metadata without a body. |

Agent streams exist after the first admitted prompt for that instance. Workflow-run streams exist after workflow admission. Missing streams return `404`.

## Read modes

A plain `GET` performs a catch-up read and returns a JSON array of event payloads.

```http
GET /runs/run_01JX...?offset=-1
```

Use `?live=long-poll` for one waitable read, or `?live=sse` for a continuous event stream. Live reads require `offset`.

```http
GET /runs/run_01JX...?offset=0000000000000000_0000000000000005&live=long-poll
GET /runs/run_01JX...?offset=0000000000000000_0000000000000005&live=sse
```

Supported `live` values are `long-poll` and `sse`. Any other value, duplicate `offset` parameter, malformed offset, or live request without `offset` returns `400`.

A long-poll read waits up to 30 seconds for new data before returning `204`. An idle SSE connection receives `: heartbeat` comment frames every 15 seconds and a keep-alive control frame after each 30-second internal wait.

## Offsets

Offsets are opaque Durable Streams coordinates. Flue currently formats them as two zero-padded integer components, such as `0000000000000000_0000000000000005`. Consumers should treat them as opaque strings and pass back the latest returned value rather than parsing them.

| Offset          | Meaning                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------ |
| `-1`            | Read from the beginning of the stream.                                                     |
| `now`           | Read from the current tail. In live mode, wait for events appended after the current tail. |
| Returned offset | Resume strictly after that event.                                                          |

The SDK exposes a resume offset as `stream.offset`. It is batch-granular: it advances only after every event in the fetched batch has been delivered. Resuming from a checkpoint does not skip undelivered events, though it can re-deliver an in-flight batch. For per-event checkpoints on workflow-run streams use the event's `eventIndex` (there it equals the stream sequence; agent streams restart `eventIndex` per prompt, so it is not an offset there); `flue logs --format ndjson` prints a per-event `offset` derived from it. `agents.send()` and `agents.prompt()` return an offset captured before that prompt is admitted, so reading from that offset yields that prompt's events. `workflows.invoke()` returns the run ID plus a server-provided `streamUrl` and an `offset` captured at admission, so reading from that offset yields the run's events from the start.

## Recent history with `tail`

`tail=N` modifies the `-1` start sentinel — "from the beginning, but at most the last N events."

This extension applies to agent and workflow-run `GET` routes. It changes only the initial position: it has no effect with `offset=now` or a concrete offset, including the concrete offsets used when a client reconnects. A value larger than the stream returns its full history.

`tail` must occur once and be an integer greater than or equal to 1. Zero, negative values, non-integers, and duplicate parameters return `400`. There is no upper cap; server read batching remains independent of the requested starting position.

```http
GET /agents/support/ticket-42?offset=-1&tail=100
GET /runs/run_01JX...?offset=-1&tail=100
```

## Response headers

| Header               | Meaning                                                                                                                                |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `Stream-Next-Offset` | Offset to use for the next read.                                                                                                       |
| `Stream-Up-To-Date`  | `true` when the read reached the current tail.                                                                                         |
| `Stream-Closed`      | `true` when the stream is closed and no more events can arrive.                                                                        |
| `Stream-Cursor`      | Cursor for long-poll continuation.                                                                                                     |
| `ETag`               | Cache validator for catch-up and long-poll reads except `offset=now`.                                                                  |
| `Cache-Control`      | `no-store` on catch-up reads, long-poll `200` responses, and `HEAD`; `no-cache` on SSE responses; absent on long-poll `204` responses. |

A conditional catch-up read with `If-None-Match` may return `304`. `offset=now` does not emit an ETag because its meaning is relative to the time of the request. `HEAD` returns stream metadata with the same stream headers and no body.

## Status behavior

| Status | Meaning                                                                                                                                                                                        |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `200`  | Read returned event data. Catch-up and long-poll bodies are JSON arrays.                                                                                                                       |
| `204`  | Long-poll reached its 30-second timeout without new data.                                                                                                                                      |
| `304`  | Conditional read matched the current ETag.                                                                                                                                                     |
| `400`  | Invalid stream query.                                                                                                                                                                          |
| `404`  | Stream does not exist or is not accessible. Agent streams use the `stream_not_found` error category; run streams use `run_not_found`. See the [Errors Reference](/docs/api/errors-reference/). |

A closed stream can still return stored history. Once caught up, its response includes `Stream-Closed: true`. Long-poll returns immediately for a closed, caught-up stream.

## SSE framing

SSE responses use named frames:

- `event: data` frames whose `data:` payload is a JSON **array** of event payloads. One frame may carry multiple events.
- `event: control` frames whose payload is a JSON object containing `streamNextOffset` and, depending on stream state, `streamCursor`, `upToDate`, and `streamClosed`. Flue emits a control frame after each data batch and as a keep-alive while an open stream stays idle.
- `: heartbeat` comment frames every 15 seconds to keep idle connections alive.

Consumers that only need event payloads can read `event: data` frames and ignore control and heartbeat frames, but should track `streamNextOffset` from control frames to resume correctly after a disconnect.

SSE is intended for live tailing, not browser caching. Flue sends `Cache-Control: no-cache` on SSE responses (matching the Durable Streams reference server) and does not rely on intermediary cacheability for stream reads.
