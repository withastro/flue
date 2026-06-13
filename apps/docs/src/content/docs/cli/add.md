---
title: flue add
description: Reference for discovering and applying Flue connector installation recipes.
lastReviewedAt: 2026-05-30
---

## Synopsis

```bash
flue add
flue add <name> [--print]
flue add <url-or-path> --category <category> [--print]
```

## Description

`flue add` fetches Markdown installation instructions for a coding agent. It does not install packages or write project files itself.

With no arguments, the command lists known connectors. With a connector name, it fetches that connector's recipe. With `--category`, it fetches a generic recipe and uses the supplied URL or path as the coding agent's research starting point.

## Arguments

| Argument        | Description                                                         |
| --------------- | ------------------------------------------------------------------- |
| `<name>`        | Known connector slug or alias.                                      |
| `<url-or-path>` | Research starting point substituted into a generic category recipe. |

## Options

| Option                  | Description                                                               |
| ----------------------- | ------------------------------------------------------------------------- |
| `--category <category>` | Fetch a generic connector recipe. Requires a URL or path argument.        |
| `--print`               | Write raw recipe Markdown to stdout regardless of coding-agent detection. |

## Connector categories

| Category  | Description                                                        |
| --------- | ------------------------------------------------------------------ |
| `sandbox` | Build a sandbox connector from provider documentation or source.   |
| `channel` | Add verified provider ingress, an SDK client, and app-owned tools. |

Run `flue add` without arguments to list the currently known connector recipes.

## Examples

```bash
flue add
flue add daytona --print
flue add daytona --print | claude
flue add github --print | codex
flue add slack --print | codex
flue add discord --print | codex
flue add teams --print | codex
flue add @cloudflare/shell --print | opencode
flue add https://e2b.dev --category sandbox --print | claude
flue add ./vendor/provider-docs --category sandbox --print | codex
flue add https://docs.stripe.com/webhooks --category channel --print | codex
```

See [Sandboxes](/docs/guide/sandboxes/), [Channels](/docs/guide/channels/), and
the [Ecosystem](/docs/ecosystem/overview/) for connector guidance.
