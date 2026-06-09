---
title: flue logs
description: Reference for reading and following workflow run events from a Flue server.
lastReviewedAt: 2026-06-09
---

## Synopsis

```bash
flue logs <workflowRunId> [--server <url>] [--header 'Name: value'] [--follow|-f|--no-follow] [--since <offset>] [--types <a,b,c>] [--limit <n>] [--format <pretty|json|ndjson>]
```

## Description

`flue logs` replays or follows events for one workflow run from a running Flue server. It is read-only and does not invoke work.

Runs are workflow-only. Direct HTTP agent prompts and dispatched agent inputs are persistent session interactions, not runs.

`flue logs` reads run events via the [Durable Streams](https://durablestreams.com/) protocol. Follow mode uses live SSE tailing with automatic reconnection and offset-based replay. Replay mode performs a single catch-up read and exits. See [Streaming Protocol](/docs/api/streaming-protocol/) for the raw HTTP contract.

`flue logs` inspects runs owned by the selected running server. It cannot inspect the private child process used by `flue run`: that one-shot process streams events directly to its command and does not publish run-inspection routes.

## Arguments

| Argument          | Description                 |
| ----------------- | --------------------------- |
| `<workflowRunId>` | Workflow run ID to inspect. |

## Options

| Option                            | Default                          | Description                                                                                                               |
| --------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `--server <url>`                  | `http://127.0.0.1:3583`          | Select the running Flue server base URL beneath which `/runs/<runId>` is published. May include an authored mount prefix. |
| `--header 'Name: value'`          | None                             | Forward a curl-style HTTP header to every request. Repeat to send multiple distinct headers.                              |
| `--follow`, `-f`                  | Automatic                        | Force live event streaming.                                                                                               |
| `--no-follow`                     | Automatic                        | Replay persisted events once and exit.                                                                                    |
| `--since <offset>`                | Beginning of history             | Resume strictly after a stream offset. Accepts integer event indices (legacy) or opaque Durable Streams offset strings.   |
| `--types <a,b,c>`                 | All event types                  | Emit only the selected comma-separated event types. Filtering is applied client-side.                                     |
| `--limit <n>`                     | Unlimited                        | Limit emitted events. Applied client-side in both replay and follow modes.                                                |
| `--format <pretty\|json\|ndjson>` | `pretty`                         | Select human-readable or line-delimited JSON output.                                                                      |

When neither follow option is passed, `flue logs` queries the admin endpoint to determine run status: active runs are followed, terminal runs are replayed once. The selected server must publish the admin mount used by the CLI, usually `/admin`; otherwise automatic follow selection fails before reading the stream. Use `--follow` or `--no-follow` when only the public `flue()` mount is available.

Run routes may expose sensitive payloads, results, errors, and events. Use repeatable `--header 'Name: value'` options to forward credentials required by application-owned middleware. Use the final HTTPS URL for remote servers to avoid credential exposure via redirects. `flue logs` rejects duplicate header names and the protocol-reserved `Accept` header.

Shell expansion keeps a literal token out of history:

```bash
flue logs workflow:summarize:01JX... --server https://example.com --header "Authorization: Bearer $TOKEN"
```

The expanded token may still be visible in process arguments while the command runs. Use short-lived, least-privilege credentials and masked CI variables where appropriate.

## Output and exit behavior

`pretty` writes human-readable events to stderr. `json` and `ndjson` are currently aliases: each writes one JSON event object per stdout line.

Request failures exit with status `1`. A failed workflow exits with status `2` only when its failing `run_end` event is consumed. Signal interruption (Ctrl-C) exits with status `130`.

## Examples

```bash
flue logs workflow:summarize:01JX...
flue logs workflow:summarize:01JX... --no-follow
flue logs workflow:summarize:01JX... --since 25
flue logs workflow:summarize:01JX... --types operation_start,operation,tool_call,log,run_end --format ndjson
```

See [Observability](/docs/guide/observability/) for workflow-run inspection and telemetry guidance.
