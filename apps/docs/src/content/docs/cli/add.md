---
title: flue add
description: Reference for fetching blueprint implementation guides.
lastReviewedAt: 2026-07-21
---

## Synopsis

```bash
flue add [<kind> <name|url>] [--print]
```

## Description

`flue add` fetches a blueprint — a Markdown implementation guide that an AI coding agent follows to build an integration into your project. It is not a package installer: the command prints the guide, and your coding agent applies it. Run with no arguments to list every available blueprint.

When invoked by a coding agent (detected from environment markers) or with `--print`, the guide's Markdown is written to stdout. From a plain shell without `--print`, instructions for piping it to a coding agent are printed instead. Blueprints are fetched at run time from the registry at `https://flueframework.com/cli/blueprints/`.

[`flue update`](/docs/cli/update/) fetches the same guide for upgrading an existing integration.

## Arguments

| Argument      | Description                                                                                                                                                                                                                                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<kind>`      | The integration category: `channel`, `database`, `sandbox`, or `tooling`.                                                                                                                                                                                                             |
| `<name\|url>` | A blueprint name (`slack`, `postgres`, `daytona`, `sentry`, …; run `flue add` with no arguments for the catalog), or an absolute URL to provider documentation, which selects the kind's generic build-from-scratch guide with the URL as the coding agent's research starting point. |

## Options

| Option    | Description                                                                  |
| --------- | ---------------------------------------------------------------------------- |
| `--print` | Write the blueprint Markdown to stdout regardless of coding-agent detection. |

## Examples

```bash
# List every available blueprint
flue add

# Add a Slack channel with Claude Code
flue add channel slack --print | claude

# Build a channel from scratch, starting the agent from a provider docs URL
flue add channel https://developers.notion.com/reference/webhooks --print | codex

# Add a Postgres persistence adapter
flue add database postgres --print | claude
```
