---
title: Configuration
description: Reference for flue.config.ts options.
---

Use `flue.config.ts` to select the build target, project root, build output directory, and built-in provider transports included in the artifact. Import `defineConfig()` from `@flue/cli/config` for type checking and editor completion:

```ts title="flue.config.ts"
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
  providers: ['anthropic'],
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

## `providers`

- **Type:** `BuiltInProvider[]`
- **Default:** `[]`

Built-in model providers whose SDK-backed transports are included in the artifact. Add every catalog-backed provider ID used by your application, such as `'anthropic'`, `'openai'`, or `'openrouter'`. Cloudflare builds include Flue's binding-backed `cloudflare/...` provider automatically.

Runtime provider registration remains separate. When `registerProvider(...)` uses a built-in API such as `openai-completions`, include a built-in provider that enables that transport, such as `'openai'`.

`'amazon-bedrock'` is supported only by Node builds. Selecting it includes Pi's Bedrock adapter and the AWS SDK in the generated artifact.

## `defineConfig()`

```ts
function defineConfig(config: UserFlueConfig): UserFlueConfig;
```

Provides type checking and editor completion for `flue.config.ts`. Returns the configuration unchanged.

## `resolveConfig()`

```ts
function resolveConfig(opts: ResolveConfigOptions): Promise<ResolvedConfigResult>;
```

Discovers, loads, validates, merges, and resolves configuration for CLI and embedding callers. Inline values override configuration-file values, which override built-in defaults. Relative inline `root` and `output` paths resolve from `opts.cwd`; relative configuration-file paths resolve from the directory containing that file.

Throws when validation fails or when no `target` is supplied.

### `ResolveConfigOptions`

| Option       | Type                           | Description                                                                                                 |
| ------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `cwd`        | `string`                       | Caller working directory and default config-search base.                                                    |
| `searchFrom` | `string \| undefined`          | Optional config-search base. Defaults to `cwd`. Relative values resolve from the process working directory. |
| `configFile` | `string \| false \| undefined` | Explicit config-file path relative to `cwd`, or `false` to skip loading.                                    |
| `inline`     | `UserFlueConfig \| undefined`  | Validated inline overrides. Relative paths resolve from `cwd`.                                              |

### `ResolvedConfigResult`

| Property     | Type                  | Description                                                 |
| ------------ | --------------------- | ----------------------------------------------------------- |
| `configPath` | `string \| undefined` | Absolute path of the loaded config file.                    |
| `userConfig` | `UserFlueConfig`      | Merged but unresolved configuration-file and inline values. |
| `flueConfig` | `FlueConfig`          | Fully resolved configuration consumed by the CLI.           |

## `resolveConfigPath()`

```ts
function resolveConfigPath(opts: ResolveConfigPathOptions): string | undefined;
```

Returns the absolute path of the selected `flue.config.*` file. Relative `cwd` values resolve from the process working directory; relative explicit `configFile` values resolve from normalized `cwd`. Returns `undefined` when no configuration file is found or when `configFile` is `false`.

Throws when an explicit `configFile` path does not exist.

### `ResolveConfigPathOptions`

| Option       | Type                           | Description                                                                        |
| ------------ | ------------------------------ | ---------------------------------------------------------------------------------- |
| `cwd`        | `string`                       | Working directory for config discovery and relative `configFile` paths.            |
| `configFile` | `string \| false \| undefined` | Explicit config-file path relative to `cwd`, or `false` to disable config loading. |
