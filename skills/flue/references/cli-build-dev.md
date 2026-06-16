# CLI, Build, And Dev

Use this for command behavior and local workflows.

## Core Commands

| Command | Use |
| --- | --- |
| `flue dev` | Watch-mode dev server. |
| `flue build` | Build deployable artifact to output directory. |
| `flue run <workflow>` | Build and invoke one workflow locally. |
| `flue connect <agent> <instance-id>` | Build and open an interactive local connection to an agent instance. |
| `flue logs <runId>` | Tail or replay workflow run events from a running Flue server. |
| `flue init --target <node|cloudflare>` | Scaffold `flue.config.*`. |
| `flue add <kind> <name|url>` | Fetch a blueprint implementation guide. |
| `flue update <kind> <name|url>` | Fetch an updated blueprint implementation guide. |
| `flue docs` | List docs pages. |
| `flue docs read <path>` | Print one docs page as markdown. |
| `flue docs search <query>` | Search docs and return JSON results. |

## Configuration Inputs

- `flue.config.ts` accepts `target`, `root`, and `output`.
- CLI flags override config values.
- `root` controls source discovery.
- `output` defaults to `<root>/dist`.
- `--env <path>` selects one alternate `.env`-format file for build/dev/run/connect.
- Without `--env`, commands load `<project>/.env` when present; shell values win.

## Target Defaults

| Target | Dev behavior |
| --- | --- |
| Node | Generated server; `flue dev --target node` defaults to port `3583`; production server defaults to `PORT` or `3000`. |
| Cloudflare | Worker-oriented build and dev flow; requires valid Wrangler configuration for deployment. |

## Agent-Oriented Docs Access

Use `flue docs search` and `flue docs read` when a consuming agent needs exact current documentation. The installable Flue skill should route and summarize; the docs command should provide page-level detail.

