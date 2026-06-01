---
title: CLI
description: Command reference for developing, running, building, and inspecting Flue applications.
lastReviewedAt: 2026-05-30
---

Install `@flue/cli` as a development dependency, then invoke the `flue` executable through your package manager:

```bash
npm install --save-dev @flue/cli
npx flue dev
```

The CLI requires Node.js `>=22.19.0`. Cloudflare development and deployment also require `wrangler` as a development dependency.

## Commands

| Command                              | Description                                                 |
| ------------------------------------ | ----------------------------------------------------------- |
| [`flue init`](/docs/cli/init/)       | Create an initial `flue.config.ts`.                         |
| [`flue dev`](/docs/cli/dev/)         | Start a watch-mode local development server.                |
| [`flue run`](/docs/cli/run/)         | Execute one workflow invocation locally.                    |
| [`flue connect`](/docs/cli/connect/) | Open an interactive local agent-instance connection.        |
| [`flue build`](/docs/cli/build/)     | Create deployable application artifacts.                    |
| [`flue logs`](/docs/cli/logs/)       | Replay or follow workflow-run events from a running server. |
| [`flue add`](/docs/cli/add/)         | Fetch connector installation recipes for a coding agent.    |

## Common application options

`flue dev`, `flue run`, `flue connect`, and `flue build` accept these options. CLI values override values from `flue.config.*`.

| Option                        | Description                                                                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--target <node\|cloudflare>` | Select the build target. Required unless supplied by configuration. `flue run` and `flue connect` support `node` only.                        |
| `--root <path>`               | Select the project root. Defaults to the selected configuration-file directory, or the configuration search directory when no file is loaded. |
| `--output <path>`             | Select the build output directory. Defaults to `<root>/dist`.                                                                                 |
| `--config <path>`             | Select a `flue.config.*` file. Relative paths resolve from the current working directory.                                                     |
| `--env <path>`                | Select one alternate `.env`-format file loaded before configuration. Relative paths resolve from `<config-base>`. Shell values win.           |

Relative CLI values passed to `--root`, `--output`, and `--config` resolve from the current working directory. Relative `--env` values resolve from `<config-base>`. Relative paths authored inside `flue.config.*` resolve from that file's directory.

`<config-base>` is the selected configuration-file directory, or the configuration search directory when no file is loaded. Without `--config`, Flue checks the `--root` directory when supplied, or the current working directory otherwise. It checks only that directory and does not search parent directories. Default `.env` discovery and relative `--env` paths use this base before configuration is evaluated; an authored `root` value does not relocate environment-file discovery.

For authored configuration fields, see [Configuration](/docs/reference/configuration/).

## Exit behavior

Ordinary command failures exit with status `1`. `flue logs` exits with status `2` when it consumes a failing `run_end` event. See the command reference for snapshot and filtering caveats. Interrupting the CLI with `SIGINT` exits with status `130`; `SIGTERM` exits with status `143`.

For the normal local development workflow, see [Develop & Build](/docs/guide/develop-and-build/).
