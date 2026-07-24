---
title: Project Layout
description: Understand the source files and generated output in a Flue project.
lastReviewedAt: 2026-07-21
---

Flue has few required conventions for file and folder layout. The examples below show the recommended structure for single- and multi-agent projects.

## Example agent codebase

```yaml
my-project/
├─ src/                  # Source directory
│  ├─ app.ts             # Server and router entrypoint (required)
│  ├─ db.ts              # Database configuration (optional)
│  ├─ cloudflare.ts      # Cloudflare-specific entrypoint (optional)
│  ├─ agent.ts
│  ├─ skills/...
│  ├─ tools/...
│  ├─ subagents/...
│  └─ channels/...
├─ package.json          # npm project configuration
├─ vite.config.ts        # Vite configuration (optional)
└─ flue.config.ts        # Flue project configuration (optional)
```

## Example multi-agent codebase

```yaml
my-project/
├─ src/                  # Source directory
│  ├─ app.ts             # Server and router entrypoint (required)
│  ├─ db.ts              # Database configuration (optional)
│  ├─ cloudflare.ts      # Cloudflare-specific entrypoint (optional)
│  └─ agents/
│     ├─ support-agent/
│     │  ├─ skills/...
│     │  ├─ tools/...
│     │  ├─ subagents/...
│     │  ├─ channels/...
│     │  └─ agent.ts
│     ├─ triage-agent/
│     └─ shared/
├─ package.json          # npm project configuration
├─ vite.config.ts        # Vite configuration (optional)
└─ flue.config.ts        # Flue project configuration (optional)
```

## Top-level files

| Path                                                                                    | Purpose                                                |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [`flue.config.ts`](/docs/reference/configuration/)                                      | Flue project configuration. Optional.                  |
| [`vite.config.ts`](/docs/guide/deploy/)                                                 | Vite build & dev server configuration. Optional.       |
| [`src/app.ts`](/docs/guide/routing/)                                                    | Application route map and server entrypoint. Required. |
| [`src/db.ts`](/docs/guide/database/)                                                    | Database configuration. Optional.                      |
| [`src/cloudflare.ts`](/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint) | Cloudflare entrypoint configuration. Optional.         |

## Source directory

`src/` is the canonical source directory for new Flue projects. When integrating Flue into another application or maintaining an existing layout, authored modules may instead live in `.flue/` or at the project root. Flue selects one source directory in this order:

1. `.flue/` — A self-contained Flue source area inside a larger application.
2. `src/` **(Recommended)** — The recommended layout for new projects.
3. The project root — A compact layout for small dedicated projects.

The first matching directory wins. Flue does not merge layouts: when `.flue/` exists, `app.ts`, `db.ts`, `cloudflare.ts`, and the `'use agent'` scan are resolved from it, not from `src/` or the project root. Authored modules may still import ordinary supporting code from elsewhere in the project.

Entry module paths (`app.ts`, `db.ts`, `cloudflare.ts`) can be configured explicitly in your `flue.config.ts` file. See [Configuration](/docs/reference/configuration/) for more details.

## Generated output

`dist/` is the default build output directory when you run `vite build`. You can customize this in your `vite.config.ts` file.
