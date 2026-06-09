---
title: Local development
description: Build, run, and inspect a Flue project during local iteration.
sidebar:
  order: 2
tableOfContents: false
---

During local development, use `flue dev` for a watching server and `flue run` when you want one private one-shot workflow invocation.

## Development commands

```bash
pnpm exec flue dev --target node
pnpm exec flue run hello --target node --payload '{"name":"Ada"}'
pnpm exec flue build --target node
```

Use stable agent instance identifiers while testing attached agent sessions. Workflow invocations are runs; direct HTTP agent prompts are persistent session interactions rather than runs.
