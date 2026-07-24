---
title: flue docs
description: Browse the documentation bundled with the Flue CLI — list every page, print one as markdown, or search the full text.
lastReviewedAt: 2026-07-21
---

## Synopsis

```bash
flue docs
flue docs read <path>
flue docs search <query>
```

## Description

`flue docs` browses the documentation that ships inside the `@flue/cli` package — the same pages published on this site. With no arguments it lists every page (`<path> -- <title>`, one per line). `read` prints one page as markdown. `search` runs a full-text query and prints JSON results.

The command reads from the local installation and makes no network requests, so the content always matches the installed CLI version rather than the live website.

## flue docs read

`flue docs read <path>` prints one page to stdout as markdown. `<path>` accepts the catalog path as printed by the listing (`guide/sandboxes`), the website URL or absolute path (`https://flueframework.com/docs/guide/sandboxes/`, `/docs/guide/sandboxes/`), or the source filename (`guide/sandboxes.md`).

## flue docs search

`flue docs search <query>` searches page titles, headings, descriptions, and body text. Everything after `search` is joined into a single query, so quoting a multi-word query is optional. Results print to stdout as JSON, best match first (at most 8):

```json
{
  "query": "durable execution",
  "results": [
    {
      "path": "guide/durability",
      "title": "Durability",
      "description": "The accepted-work contract — what survives crashes, restarts, and redeploys...",
      "excerpt": "Durability is Flue's contract for accepted work: once an input is admitted…",
      "score": 35.8
    }
  ]
}
```

Pass a result's `path` to `flue docs read`.

## Examples

```bash
# List every page with its path and description
flue docs

# Print one page as markdown
flue docs read guide/sandboxes

# Search, then read the top result
flue docs search durable execution
flue docs read guide/durability
```

For coding agents, the typical loop is `flue docs search <query>` to find a page, then `flue docs read <path>` to read it.

See the [CLI overview](/docs/cli/overview/) for the other `flue` commands.
