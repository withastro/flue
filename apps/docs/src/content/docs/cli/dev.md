---
title: flue dev
description: Reference for starting a watch-mode local Flue development server.
lastReviewedAt: 2026-05-30
---

## Synopsis

```bash
flue dev [--target <node|cloudflare>] [--root <path>] [--output <path>] [--config <path>] [--port <number>] [--env <path>]
```

## Description

`flue dev` builds the selected project, starts a local server, watches project files, and reloads after relevant changes. Editing, creating, or deleting an auto-discovered `flue.config.*` file restarts the local development session with freshly resolved configuration. Explicit `--config <path>` files are watched even when they live outside the project root. A configuration restart interrupts active local requests and streaming connections. When an edited configuration is invalid, the command waits for the next configuration change and starts a new session after the error is corrected.

## Options

| Option                        | Default                                                    | Description                                                                                                                         |
| ----------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `--target <node\|cloudflare>` | Configuration value                                        | Select the development target. Required unless supplied by configuration.                                                           |
| `--root <path>`               | Selected config-file directory, or config search directory | Select the project root.                                                                                                            |
| `--output <path>`             | `<root>/dist`                                              | Select the build output directory.                                                                                                  |
| `--config <path>`             | Auto-discovered `flue.config.*`                            | Select a configuration file.                                                                                                        |
| `--port <number>`             | `3583`                                                     | Select the local server port.                                                                                                       |
| `--env <path>`                | `<config-base>/.env`, when present                         | Select one alternate `.env`-format file loaded before configuration. Relative paths resolve from `<config-base>`. Shell values win. |

## Target-specific behavior

### Node.js

Builds the Node artifact, starts the generated server, and rebuilds and respawns it after relevant file changes.

### Cloudflare

Starts Vite with the official Workers integration. Cloudflare runtime bindings continue to use the official `.dev.vars`, `.env`, and `CLOUDFLARE_ENV` conventions.

## Examples

```bash
flue dev
flue dev --target node
flue dev --target cloudflare --port 8787
flue dev --env .env.staging
```

See [Develop & Build](/docs/guide/develop-and-build/) for the local development workflow.
