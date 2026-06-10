---
title: flue run
description: Reference for executing one workflow invocation from the command line.
lastReviewedAt: 2026-05-30
---

## Synopsis

```bash
flue run <workflow> [--target node] [--payload <json>] [--root <path>] [--output <path>] [--config <path>] [--env <path>]
```

## Description

`flue run` builds the selected Node project and executes one discovered workflow locally. It uses private child-process communication, so the workflow does not need public HTTP exposure and application ingress middleware is not executed.

A workflow invocation is a finite run with a run ID. Use `flue connect` for interactive agent-instance sessions.

## Arguments

| Argument     | Description                     |
| ------------ | ------------------------------- |
| `<workflow>` | Workflow module name to invoke. |

## Options

| Option             | Default                                                    | Description                                                                                                                         |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--payload <json>` | `{}`                                                       | Supply the workflow payload as JSON.                                                                                                |
| `--target node`    | Configuration value                                        | Select the supported local execution target.                                                                                        |
| `--root <path>`    | Selected config-file directory, or config search directory | Select the project root.                                                                                                            |
| `--output <path>`  | `<root>/dist`                                              | Select the build output directory.                                                                                                  |
| `--config <path>`  | Auto-discovered `flue.config.*`                            | Select a configuration file.                                                                                                        |
| `--env <path>`     | `<config-base>/.env`, when present                         | Select one alternate `.env`-format file loaded before configuration. Relative paths resolve from `<config-base>`. Shell values win. |

## Output and events

Build diagnostics are written to stdout before execution. Run identity and streamed events are written to stderr. A successful non-null terminal workflow result is written as formatted JSON to stdout.

The printed run ID identifies this workflow invocation in inline output and CI logs. The temporary child process owns its run record and streams events directly to the command. It does not publish run-inspection routes, and its history disappears when the command exits. Use `flue logs` only for runs owned by a selected running server.

## Target support

`flue run` supports Node builds only. To exercise a Cloudflare-target workflow locally, start `flue dev --target cloudflare` and call its public ingress surface.

## Examples

```bash
flue run hello --target node
flue run summarize --target node --payload '{"text":"hello"}' --env .env.staging
```

See [Workflows](/docs/guide/workflows/) for authoring and invoking workflows.
