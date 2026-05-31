---
title: Configuration
description: Reference for flue.config.ts options.
---

Use `flue.config.ts` to select the build target, project root, and build output directory. Import `defineConfig()` from `@flue/cli/config` for type checking and editor completion:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

Only the options listed below are accepted. Flue recognizes `flue.config.ts`, `.mts`, `.mjs`, `.js`, `.cjs`, and `.cts`, in that priority order. TypeScript configuration files are loaded directly by Node and must use erasable syntax.

For source-module placement, see [Project Layout](/docs/guide/project-layout/). For configuration-file discovery, command-line overrides, and environment files, see the [CLI reference](/docs/cli/overview/).

## `target`

- **Type:** `'node' | 'cloudflare'`
- **Default:** none

Build and development target. This option is required unless `--target` is passed to the CLI.

- `'node'` builds a Node.js server.
- `'cloudflare'` builds a Workers-compatible application.

## `root`

- **Type:** `string`
- **Default:** directory containing the selected `flue.config.*` file, or the selected search directory when no configuration file is loaded

Project root. Must not be empty. Relative values loaded from a configuration file resolve from the directory containing that file.

Flue uses the first matching source location:

1. `<root>/.flue` when it exists as a directory
2. `<root>/src` when it exists as a directory
3. `<root>`

## `output`

- **Type:** `string`
- **Default:** `<root>/dist`

Build output directory. Must not be empty. Relative values loaded from a configuration file resolve from the directory containing that file, not from `root`.

## `defineConfig()`

```ts
function defineConfig(config: UserFlueConfig): UserFlueConfig;
```

Provides type checking and editor completion for `flue.config.ts`. Returns the configuration unchanged.
