---
title: CLI
description: The flue command-line interface — invocation, command catalog, global flags, and exit codes.
lastReviewedAt: 2026-07-21
---

The `flue` CLI ships in the `@flue/cli` package as a single `flue` binary. It scaffolds projects, runs one agent module locally, fetches integration blueprints, and reads the documentation bundled with your installed version.

The CLI is not the build tool. Dev servers and production builds are owned by [Vite](/docs/guide/deploy/): `vite dev` and `vite build`, with the `flue()` plugin from `@flue/vite` in `vite.config.ts`.

## Invocation

`@flue/cli` requires Node.js 22.19 or newer. [`flue init`](/docs/cli/init/) scaffolds it as a `devDependency`, and the [getting started guide](/docs/guide/getting-started/) installs it alongside `@flue/runtime`:

```bash
npm install @flue/runtime @flue/cli
```

The `flue` bin is then available through your package manager's runner (`npx flue`, `pnpm flue`, `yarn flue`) or from `package.json` scripts:

```bash
npx flue run src/agents/assistant.ts -m "Say hello"
```

## Commands

- [`flue init [directory]`](/docs/cli/init/) — scaffold a starter Flue project, prompting for the build target and server setup when flags are omitted.
- [`flue run <path>`](/docs/cli/run/) — run one agent module locally without a server: submit one message, stream the turn, print the reply, exit.
- [`flue add [kind] [name|url]`](/docs/cli/add/) — fetch a blueprint implementation guide for a coding agent to follow; with no arguments, list the available blueprints.
- [`flue update <kind> <name|url>`](/docs/cli/update/) — fetch the same blueprint guide for updating an existing integration.
- [`flue docs [read|search]`](/docs/cli/docs/) — list the bundled documentation pages, print one as markdown, or search them.

Each command page is the reference for that command's arguments, flags, and output. Every command prints its primary payload to stdout and everything else — prompts, streaming output, errors — to stderr, so piping stdout is always safe.

## Global flags

| Flag              | Description                                                                           |
| ----------------- | ------------------------------------------------------------------------------------- |
| `--help`, `-h`    | Print usage to stdout and exit 0. Works globally and per command (`flue run --help`). |
| `--version`, `-v` | Print the `@flue/cli` version to stdout and exit 0.                                   |

There are no other global flags; every command rejects flags it does not declare.
