---
title: Project configuration
description: Configure source roots, build targets, and generated artifacts for a Flue application.
---

A project-level `flue.config.ts` file lets you set defaults for development and builds without repeating CLI flags.

## Configuration file

```ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
  root: './',
  output: './dist',
  providers: ['anthropic'],
});
```

Relative paths resolve against the directory containing the configuration file. Command-line flags override matching configuration values.

## Supported options

| Option      | Purpose                                            | Example                    |
| ----------- | -------------------------------------------------- | -------------------------- |
| `target`    | Select the deployment/runtime target.              | `'node'`                   |
| `root`      | Choose the Flue project root.                      | `'./examples/hello-world'` |
| `output`    | Write deployable artifacts elsewhere.              | `'./dist'`                 |
| `providers` | Include built-in SDK-backed provider transports.   | `['anthropic']`            |

## Next steps

Continue to [Targets and output](/docs/config/targets-and-output/) for build-output conventions or open the [Agent API](/docs/api/agent-api/) reference.
