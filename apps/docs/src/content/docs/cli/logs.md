---
title: flue logs
description: Reference for reading and following workflow run events from a Flue server.
lastReviewedAt: 2026-05-30
---

## Synopsis

```bash
flue logs <workflowRunId> [--server <url>] [--header 'Name: value'] [--follow|-f|--no-follow] [--since <eventIndex>] [--types <a,b,c>] [--limit <n>] [--format <pretty|json|ndjson>]
```

## Description

`flue logs` replays or follows events for one workflow run from a running Flue server. It is read-only and does not invoke work.

Runs are workflow-only. Direct HTTP agent prompts and dispatched agent inputs are persistent session interactions, not runs.

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
| `--since <eventIndex>`            | Beginning of history             | Resume strictly after an event index.                                                                                     |
| `--types <a,b,c>`                 | All event types                  | Emit only the selected comma-separated event types.                                                                       |
| `--limit <n>`                     | Replay: `100`; follow: unlimited | Limit emitted events. Replay requests accept at most `1000`.                                                              |
| `--format <pretty\|json\|ndjson>` | `pretty`                         | Select human-readable or line-delimited JSON output.                                                                      |

When neither follow option is passed, `flue logs` follows active runs and requests one persisted-event snapshot for terminal runs. The snapshot endpoint is bounded: it returns the first `100` matching events by default and accepts a maximum `--limit` of `1000`. `flue logs` does not paginate snapshots.

Run routes may expose sensitive payloads, results, errors, and events. Use repeatable `--header 'Name: value'` options to forward credentials required by application-owned middleware. `flue logs` rejects redirects so credentials are sent only to the selected `--server`; use the final HTTPS URL for remote servers. It also rejects duplicate header names and the protocol-owned `Accept` and `Last-Event-ID` headers.

Shell expansion keeps a literal token out of history:

```bash
flue logs run_01H... --server https://example.com --header "Authorization: Bearer $TOKEN"
```

The expanded token may still be visible in process arguments while the command runs. Use short-lived, least-privilege credentials and masked CI variables where appropriate.

## Output and exit behavior

`pretty` writes human-readable events to stderr. `json` and `ndjson` are currently aliases: each writes one JSON event object per stdout line.

Request failures exit with status `1`. A failed workflow exits with status `2` only when its failing `run_end` event is consumed. Stream-framed server failures are not currently guaranteed to produce a nonzero exit status.

## Examples

```bash
flue logs run_01H...
flue logs run_01H... --no-follow
flue logs run_01H... --since 25
flue logs run_01H... --types operation_start,operation,tool_call,log,run_end --format ndjson
```

See [Observability](/docs/guide/observability/) for workflow-run inspection and telemetry guidance.
