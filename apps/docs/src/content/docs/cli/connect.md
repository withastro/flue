---
title: flue connect
description: Reference for opening an interactive local agent-instance session from the command line.
lastReviewedAt: 2026-05-30
---

## Synopsis

```bash
flue connect <agent> <instance-id> [--target node] [--root <path>] [--output <path>] [--config <path>] [--env <path>]
```

## Description

`flue connect` builds the selected Node project and opens a local connection to one discovered agent instance. Enter one prompt per line. The connection remains open until end-of-input or interruption so the agent instance can be reused between prompts.

The local connection uses private child-process communication. The agent does not need public HTTP exposure, and application ingress middleware is not executed.

## Arguments

| Argument        | Description                      |
| --------------- | -------------------------------- |
| `<agent>`       | Agent module name to connect to. |
| `<instance-id>` | Agent-instance identifier.       |

## Options

| Option             | Default                                                    | Description                                                                                                                         |
| ------------------ | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--target node`    | Configuration value                                        | Select the supported local connection target.                                                                                       |
| `--root <path>`    | Selected config-file directory, or config search directory | Select the project root.                                                                                                            |
| `--output <path>`  | `<root>/dist`                                              | Select the build output directory.                                                                                                  |
| `--config <path>`  | Auto-discovered `flue.config.*`                            | Select a configuration file.                                                                                                        |
| `--env <path>`     | `<config-base>/.env`, when present                         | Select one alternate `.env`-format file loaded before configuration. Relative paths resolve from `<config-base>`. Shell values win. |

## Output and exit behavior

Build diagnostics are written to stdout before the connection opens. Streamed agent events and prompt errors are written to stderr. A successful non-null prompt result is written as formatted JSON to stdout. Prompt errors do not close the interactive connection. End-of-input closes the connection.

## Target support

`flue connect` supports local Node builds only. Use the [SDK](/docs/sdk/overview/) to interact with a deployed application.

## Examples

```bash
flue connect assistant customer-123 --target node
flue connect assistant customer-123 --env .env.staging
```

See [Develop & Build](/docs/guide/develop-and-build/) for the local development workflow.
