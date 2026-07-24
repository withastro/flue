---
title: Configuration
description: Reference for the flue.config file, the flue() Vite plugin and its option merging, target detection, and how vite dev, vite build, and flue run resolve configuration.
lastReviewedAt: 2026-07-21
---

Flue project configuration has two authoring surfaces and one programmatic module:

- **`flue.config.ts`** — an optional file at the project root describing the project: its build target, entry-module paths, and the `'use agent'` scan scope.
- **Inline options to [`flue()`](#the-flue-vite-plugin)** — the Vite plugin accepts the same fields and merges them over the discovered file, per field.
- **[`@flue/runtime/config`](#flueruntimeconfig)** — the module that implements discovery, validation, and resolution, for hosts and tooling.

Two consumers read the configuration: the `flue()` Vite plugin (`vite dev`, `vite build`, `vite preview`) and [`flue run`](/docs/cli/run/). Per-consumer behavior is specified in [Resolution by consumer](#resolution-by-consumer).

## `flue.config.ts`

```ts
// flue.config.ts
import { defineConfig } from '@flue/runtime/config';

export default defineConfig({
  target: 'node',
});
```

The file is optional, every field is optional, and the configuration must be the module's **default export**. A module without an object default export fails with `[flue] <file> must export a config object as the default export.`

### `defineConfig()`

```ts
function defineConfig(config: FlueConfig): FlueConfig;
```

Returns the configuration unchanged; exists for type checking and editor completion. A plain object default export is equally valid.

### File discovery

The config file is searched in the project root — the Vite root for the `flue()` plugin, the working directory for `flue run`. Basenames are tried in this priority order (first hit wins):

1. `flue.config.ts`
2. `flue.config.mts`
3. `flue.config.mjs`
4. `flue.config.js`
5. `flue.config.cjs`
6. `flue.config.cts`

When several of these files coexist in the same directory, the `flue()` plugin logs a warning naming the winner (`[flue] Multiple Flue config files found (…); using <basename>.`); `flue run` selects silently by the same priority. There is no user-facing option to point the plugin or the CLI at a differently named config file; an explicit path exists only on the [programmatic API](#resolveflueconfigpath).

### Module evaluation

The config module is evaluated with Node's native dynamic `import()`, cache-busted on every load — not through Vite. Vite aliases, plugins, and transforms do not apply; every import in the config file must be resolvable by Node itself.

TypeScript config files rely on Node's type-stripping loader:

- Node ≥ 22.19 or ≥ 23.6 is required. On older Node, loading a `.ts` config fails with `[flue] Cannot load <file>: this Node (v…) does not support TypeScript natively.`
- Only erasable TypeScript syntax is accepted. `enum`, `namespace` with runtime code, parameter properties, and decorators fail with `[flue] <file> uses TypeScript syntax that Node's type-stripping loader doesn't support …`.

### Validation

The default export is validated strictly against the field set below:

- An unknown field is an error. (`flue run` is the one exception: it drops unknown keys instead of rejecting; see [`flue run`](#flue-run).)
- A non-object value fails with `[flue] <source> must be a config object.`
- Field-level failures (invalid `target` value, empty path strings) are reported together as `[flue] Invalid config in <source>:` followed by one line per field.

## Configuration fields

```ts
interface FlueConfig {
  target?: 'node' | 'cloudflare';
  app?: string;
  db?: string;
  cloudflare?: string;
  agents?: string;
  providers?: string[];
}
```

`FlueConfig` is exported from `@flue/runtime/config`. The same object shape is accepted by the config file's default export and by [`flue()`](#the-flue-vite-plugin) inline options.

### `target`

The build and development target.

- `'node'` — build a self-starting Node.js server. See [the Node.js target](/docs/guide/node-target/).
- `'cloudflare'` — build a Workers-compatible application with one Durable Object class per agent. See [the Cloudflare target](/docs/guide/cloudflare-target/).
- Default: unset. The `flue()` plugin then auto-detects the target from the Vite plugin array — see [Target detection](#target-detection). An explicit value overrides detection.
- `flue run` ignores `target` entirely; it is always Node-local.

### `app`

Path to the application entry (`app.ts`) — the project's route map and the only module the Vite plugin requires to exist. See [Routing](/docs/guide/routing/).

- Default: the entry lookup `app.{ts,mts,js,mjs}` under the [source root](#entry-path-resolution). When no file resolves, `vite dev` and `vite build` fail with `[flue] No app entry found. …`.
- A relative value resolves from the config file's directory. An explicit path that does not exist is an error: ``[flue] Configured `app` entry not found: <path>``.

### `db`

Path to the persistence entry (`db.ts`), whose default export is the project's persistence adapter. Node target only. See [Database](/docs/guide/database/).

- Default: the entry lookup `db.{ts,mts,js,mjs}` under the source root; when nothing resolves, the Node target uses its built-in SQLite default.
- Same resolution and existence rules as `app`.
- On the Cloudflare target, a resolved `db` entry — discovered or explicit — is a hard error: `[flue] Custom persistence (db.ts) is not supported on the Cloudflare target. …` Cloudflare agents persist in Durable Object SQLite.

### `cloudflare`

Path to the non-HTTP Cloudflare handlers entry (`cloudflare.ts`), whose default export contributes Worker handlers (`scheduled`, `queue`, …) to the generated Worker entry. See [Extending the `cloudflare.ts` entrypoint](/docs/guide/cloudflare-target/#extending-cloudflarets-entrypoint).

- Default: the entry lookup `cloudflare.{ts,mts,js,mjs}` under the source root.
- Same resolution and existence rules as `app`.
- Consumed only by the Cloudflare target; a resolved entry is inert on Node.

### `agents`

A glob narrowing the [`'use agent'` scan](/docs/guide/building-agents/#use-agent-directive), interpreted relative to the source root (for example `'agents/**/*.ts'`).

- Default: the entire source root, recursively (`**/*.{ts,mts,js,mjs}`).
- Matches are always restricted to `.ts`/`.mts`/`.js`/`.mjs` files. `node_modules/`, `dist/`, `output/`, and `.wrangler/` directories are always excluded, and dot-directories are not matched.
- `flue run` ignores `agents`; it takes an explicit module path and performs no scan.

### `providers`

The providers registered at server start, by provider ID (for example `['anthropic', 'openai']`). Each entry becomes a `@earendil-works/pi-ai/providers/<id>` factory import in the generated entry — `'cloudflare'` selects Flue's own Workers AI binding provider instead — so only the listed providers ship in the build.

- Default: unset — every built-in provider registers, the Workers AI binding provider included on the Cloudflare target.
- The list is exhaustive: on the Cloudflare target, `cloudflare/...` models require `'cloudflare'` in the list. On the Node target, `'cloudflare'` is a config error — the Workers AI binding only exists on Workers.
- Entries are validated as lowercase alphanumerics and dashes; an ID Pi doesn't ship fails the build with the unresolvable import path.
- Custom providers registered with `setProvider()` in `app.ts` are unaffected, and a user registration always wins over a listed provider with the same ID.
- `flue run` ignores `providers`; it always registers the full built-in set.

The full semantics live in the [Provider API reference](/docs/reference/provider-api/#the-providers-config).

## Entry-path resolution

Both consumers resolve the configured fields against the filesystem with the same rules:

- **Source root.** Authored modules are discovered from `<root>/.flue` when it exists as a directory, otherwise `<root>/src`, otherwise the project root itself. See [Project layout](/docs/guide/project-layout/).
- **Default entry lookup.** An unset `app`/`db`/`cloudflare` field falls back to `<sourceRoot>/<field>.<ext>`, trying extensions in the order `ts`, `mts`, `js`, `mjs`. A missing default entry is not an error at resolution time; whether it is required is the consumer's call (`app` is required by `vite dev`/`vite build`; nothing is required by `flue run` or `vite preview`).
- **Explicit paths.** A set field resolves from the config file's directory (from the project root when the value came only from inline `flue()` options) and must exist; a missing explicit entry throws ``[flue] Configured `<field>` entry not found: <path>``.

## The `flue()` Vite plugin

```ts
import { flue } from '@flue/vite';

function flue(config?: FlueConfig): Plugin[];
```

Makes a Vite project a Flue application. Returns an array of plugins; the core plugin is named `flue`. Adding `flue()` to the same Vite config more than once is an error. See [Deploy](/docs/guide/deploy/) for the build-and-deploy walkthrough on each target.

```ts
// vite.config.ts
import { defineConfig } from 'vite';
import { flue } from '@flue/vite';

export default defineConfig({
  plugins: [flue({ target: 'node' })],
});
```

The plugin options are a `FlueConfig`. During Vite config resolution the plugin:

1. Validates the inline options (failures name `inline flue() options` as the source).
2. Discovers and loads `flue.config.*` from the Vite root.
3. Merges inline options over the file, per field: a defined inline field wins; an `undefined` inline field falls through to the file value. All fields are scalars; there is no deep merging.
4. Resolves the project layout and, outside preview, runs the `'use agent'` scan.

The project resolves against the Vite root (`root` in the Vite config, else the working directory). If another plugin changes `root` after `flue()` has resolved, config resolution fails with an error directing you to set `root` in the Vite config itself.

### Target detection

The effective target is decided in this order:

1. The merged `target` field, when set.
2. `'cloudflare'` when `@cloudflare/vite-plugin` is present in the resolved Vite plugin array.
3. `'node'` otherwise.

Cloudflare wiring is validated at config-resolution time; each failure is a distinct error:

- `target: 'cloudflare'` without `@cloudflare/vite-plugin` in the plugin array.
- `cloudflare()` listed before `flue()` — `flue()` must precede it, because the sibling's config resolution invokes Flue's [worker-config customizer](#flueworkerconfig) and needs the completed project resolution and agent scan.
- The Cloudflare plugin present but not visible to `flue()` as a plain `plugins` entry (wrapped in a Promise, or injected by another plugin).
- `cloudflare()` invoked without `config: flueWorkerConfig()`, leaving the sibling without Flue's Worker entry and Durable Object bindings.

### Vite configuration set by the plugin

On every target and mode the plugin sets `appType: 'custom'` and dedupes `@flue/runtime` and `hono` to a single copy per module graph.

On the **Node target**, `vite build` additionally forces: `build.ssr: true`, `build.target: 'node22'`, the two-entry rolldown input (the self-starting `server.mjs` plus the non-listening `app.mjs` chunk it imports), `.mjs` entry and chunk file names, and ES module output. Node builtins, the project's `package.json` dependencies (with their subpaths), and Flue's optional native dependencies stay external to the bundle. User-set values at these forced paths are overridden with a warning (`[flue] The following Vite config options are overridden by flue(): …`), not an error. The user keeps:

- `build.outDir` — default `'dist'`. An output directory that resolves to (or contains) the project root or source root — including through symlinks or junctions — is rejected, because the build empties it: `[flue] build.outDir "…" resolves to "…", which is or contains the … . …`
- `build.sourcemap` — default `true`.
- `build.emptyOutDir` — left to Vite's own default and fencing.

In `vite dev` and `vite preview` (both targets), `server.cors` / `preview.cors` default to a localhost-only credentialed policy that also exposes the durable-stream coordination headers (`Stream-Next-Offset`, `Stream-Up-To-Date`, `Location`); an explicit user value replaces the default. Deployed servers apply no CORS — see [Routing](/docs/guide/routing/).

On the Node target, `vite dev` also loads the project's `.env` file set (Vite's standard `.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`) into `process.env` with shell-wins semantics, matching `flue run`. Cloudflare dev-time variables (`.dev.vars`) belong to the Cloudflare plugin instead.

On the **Cloudflare target** the plugin imposes no build configuration; `@cloudflare/vite-plugin` owns the Worker build, dev server, and preview.

### Virtual modules

The plugin serves six virtual modules; they are resolvable only inside module graphs the plugin owns:

- `virtual:flue/app` — the resolved `app` entry (required).
- `virtual:flue/db` — the resolved `db` entry, or a stub exporting `undefined` (the built-in default adapter is then used).
- `virtual:flue/agents` — the scanned `'use agent'` module set.
- `virtual:flue/providers` — provider registration generated from [`providers`](#providers) (or the all-built-ins default).
- `virtual:flue/server` — the Node server bootstrap.
- `virtual:flue/worker` — the generated Cloudflare Worker entry (wrangler `main`; one Durable Object class per agent).

### `FlueVitePluginApi`

```ts
interface FlueVitePluginApi {
  readonly resolved: FlueResolvedProjectInfo | undefined;
}

interface FlueResolvedProjectInfo {
  readonly config: FlueConfig;
  readonly configPath: string | undefined;
  readonly project: ResolvedFlueProject;
  readonly target: 'node' | 'cloudflare';
  readonly agents: readonly AgentScanResult[];
}
```

Exported from `@flue/vite`. The core `flue` plugin exposes `FlueVitePluginApi` on its `api` field as a read surface for other tools. `resolved` is `undefined` until Vite config resolution completes.

- `config` — the merged Flue config (file + inline options).
- `configPath` — absolute path of the discovered `flue.config.*`, if any.
- `project` — the resolved filesystem layout; see [`ResolvedFlueProject`](#resolveflueproject).
- `target` — the effective target after [detection](#target-detection).
- `agents` — the scanned agent set; live in dev (reflects the latest re-scan).

## `flueWorkerConfig()`

```ts
import { flue, flueWorkerConfig } from '@flue/vite';

function flueWorkerConfig(): FlueWorkerConfigCustomizer;

type FlueWorkerConfigCustomizer = (config: object) => void;
```

Creates the worker-config customizer for the Cloudflare target, passed to the sibling plugin's `config` option:

```ts
// vite.config.ts
import { cloudflare } from '@cloudflare/vite-plugin';
import { flue, flueWorkerConfig } from '@flue/vite';

export default defineConfig({
  plugins: [flue(), cloudflare({ config: flueWorkerConfig() })],
});
```

`flueWorkerConfig()` must be called after `flue()` in the same Vite config evaluation; calling it first throws `[flue] flueWorkerConfig() was called before flue(). …`. The customizer runs inside the Cloudflare plugin's config resolution, against the resolved config of the active Cloudflare environment (`CLOUDFLARE_ENV`), and contributes exactly four things:

- `main` — set to `virtual:flue/worker`, the generated Worker entry, unless the user's wrangler config sets its own `main` (which can re-export the generated module: `export * from 'virtual:flue/worker'`).
- One Durable Object binding per scanned agent. A user binding that occupies a Flue-reserved binding name must match the binding Flue would generate (same `class_name`, no `script_name`/`environment`); a conflicting one throws `[flue] wrangler config durable object binding "…" is reserved by Flue. …`.
- The `nodejs_compat` compatibility flag, unioned into `compatibility_flags`.
- Validation of a user-set `compatibility_date`: it must be `YYYY-MM-DD` and at least `2026-04-01`. An older date is an error, not a silent bump. An unset date is left to the Cloudflare plugin's own default.

Everything else in the wrangler config — `name`, user Durable Objects, containers, R2 buckets, migrations — passes through untouched. Flue never reads, merges, or writes a wrangler config file; see [`wrangler.jsonc`](/docs/guide/cloudflare-target/#wranglerjsonc). Under `vite preview` the customizer is a no-op (preview serves the already-built Worker output).

## Resolution by consumer

### `vite dev`

Config resolution runs in the plugin's `config` hook: discover `flue.config.*` in the Vite root, merge inline options, resolve entries, require `app`, scan agents. The dev server then keeps the resolution live:

- An edit to the discovered `flue.config.*` — or the creation of any `flue.config.*` candidate when none existed at startup — restarts the dev server, which re-runs the full resolution.
- A change to the scanned agent set (file added/removed, directive or identity change) regenerates `virtual:flue/agents` and reloads the app on Node; on Cloudflare it restarts the dev server, so the Worker entry and Durable Object bindings are regenerated.
- On Cloudflare, an authored `wrangler.jsonc`/`wrangler.json`/`wrangler.toml` appearing or disappearing at the root restarts the dev server; edits to an existing file are handled by the Cloudflare plugin itself.
- Scan failures during watching (mid-edit syntax, duplicate identities) are logged and leave the last good agent set in place.

### `vite build`

Same resolution as `vite dev`, once. `app` is required; the agent scan must succeed; on Node the [forced build configuration](#vite-configuration-set-by-the-plugin) and the `build.outDir` safety check apply; on Cloudflare the ordering and wiring [validation](#target-detection) applies and the merged wrangler config is emitted into the build output by the Cloudflare plugin.

### `vite preview`

Preview is artifact-based: the config file is still discovered, loaded, and validated, and entries are resolved, but nothing is required, no agent scan runs, and nothing is generated. Node preview serves the built `dist/` output; Cloudflare preview is owned entirely by the Cloudflare plugin (workerd over the built Worker).

### `flue run`

[`flue run`](/docs/cli/run/) resolves configuration directly, without Vite config or the plugin:

- `flue.config.*` is discovered from the **working directory** (which is also the project root); `vite.config.ts` is never read.
- Unknown config keys are dropped before validation instead of rejected.
- `target` and `agents` are ignored: the run is always Node-local, and the agent module is the explicit `<path>` argument, not a scan result.
- `db` is honored; without one, the run uses a SQLite database at `node_modules/.cache/flue/run.db` under the project root.
- `app` and `cloudflare` are resolved but unused. Explicit-path existence checks still apply: a configured entry that does not exist fails the run.

## `@flue/runtime/config`

The programmatic configuration module. It is host-side tooling — it touches the filesystem — and must be imported from build or CLI code, never from agent modules. [`defineConfig()`](#defineconfig) and [`FlueConfig`](#configuration-fields) are documented above.

### `parseFlueConfig()`

```ts
function parseFlueConfig(value: unknown, source?: string): FlueConfig;
```

Validates a raw config value (a config module's default export, or inline plugin options) against the strict field set. Throws with per-field diagnostics naming `source` (default `'flue config'`). Returns the validated `FlueConfig`.

### `mergeFlueConfig()`

```ts
function mergeFlueConfig(file: FlueConfig, inline: FlueConfig): FlueConfig;
```

Merges host-provided config over a discovered file config, per field: defined `inline` fields win, `undefined` fields fall through to `file`.

### `resolveFlueConfigPath()`

```ts
interface ResolveFlueConfigPathOptions {
  cwd: string;
  configFile?: string;
}

function resolveFlueConfigPath(opts: ResolveFlueConfigPathOptions): string | undefined;
```

Resolves the absolute path of the project's `flue.config.*`, or `undefined` when none exists.

- `cwd` — directory searched for the [config basenames](#file-discovery), and the base for `configFile`.
- `configFile` — explicit config path (relative to `cwd`, or absolute). An explicit path that does not exist throws `[flue] Config file not found: <path>` rather than returning `undefined`.

### `loadFlueConfig()`

```ts
interface LoadedFlueConfig {
  configPath: string | undefined;
  config: FlueConfig;
}

function loadFlueConfig(opts: ResolveFlueConfigPathOptions): Promise<LoadedFlueConfig>;
```

Discovers, evaluates, and validates the project config in one step, under the [module-evaluation rules](#module-evaluation). Returns `{ configPath: undefined, config: {} }` when no config file exists. Throws on a missing explicit `configFile`, a non-object default export, or validation failure.

### `loadFlueConfigModule()`

```ts
function loadFlueConfigModule(absConfigPath: string): Promise<Record<string, unknown>>;
```

Evaluates a config file via native dynamic `import()` (cache-busted per call) and returns the module namespace, unvalidated. Type-stripping failures and unsupported-Node failures are rethrown with the diagnostic messages listed under [Module evaluation](#module-evaluation).

### `resolveSourceRoot()`

```ts
function resolveSourceRoot(root: string): string;
```

Returns the directory authored modules are discovered from: `<root>/.flue` when it exists as a directory, otherwise `<root>/src`, otherwise `root`.

### `discoverProjectEntry()`

```ts
function discoverProjectEntry(sourceRoot: string, basename: string): string | undefined;
```

Locates `<sourceRoot>/<basename>.<ext>` using the extension priority `ts`, `mts`, `js`, `mjs`. Returns `undefined` when no candidate exists.

### `resolveFlueProject()`

```ts
interface ResolveFlueProjectOptions {
  root: string;
  config?: FlueConfig;
  configPath?: string;
}

function resolveFlueProject(opts: ResolveFlueProjectOptions): ResolvedFlueProject;
```

Resolves a validated config against the filesystem, applying the rules in [Entry-path resolution](#entry-path-resolution). Missing explicit entries throw; missing default entries resolve to `undefined` (whether that is an error is the caller's decision).

- `root` — project root (absolute, or resolved from the working directory).
- `config` — the merged config to resolve. Default `{}`.
- `configPath` — path of the config file the values came from; relative entry paths resolve from its directory. Defaults to resolving from `root`.

### `ResolvedFlueProject`

```ts
interface ResolvedFlueProject {
  root: string;
  sourceRoot: string;
  target: 'node' | 'cloudflare' | undefined;
  app: string | undefined;
  db: string | undefined;
  cloudflare: string | undefined;
  agents: string | undefined;
}
```

A project's fully resolved filesystem layout. `root`, `sourceRoot`, and the entry fields are absolute paths; `target` is passed through from the config (detection is the Vite plugin's job); `agents` is the scan glob verbatim as authored.

### Constants

```ts
const FLUE_CONFIG_BASENAMES: readonly string[];
const PROJECT_ENTRY_EXTENSIONS: readonly string[];
```

- `FLUE_CONFIG_BASENAMES` — the [config basenames](#file-discovery), in priority order.
- `PROJECT_ENTRY_EXTENSIONS` — the entry extension priority: `['ts', 'mts', 'js', 'mjs']`.

## What configuration does not cover

- **Environment variables.** `flue.config.ts` declares no secrets and reads no `.env` mapping; API keys and runtime variables come from the process environment. See [Environment and secrets](/docs/guide/node-target/#environment-and-secrets).
- **Wrangler configuration.** Worker name, routes, user bindings, containers, and migrations live in your own `wrangler.jsonc`; Flue only [contributes](#flueworkerconfig) its derived values at build time.
- **Agent behavior.** Models, tools, sandboxes, and durability are configured in agent modules, not in `flue.config.ts`. See [Models](/docs/guide/models/) and [Tools](/docs/guide/tools/).
- **Vite options.** `flue.config.ts` carries no Vite configuration; server ports, plugins, and build overrides stay in `vite.config.ts`.
