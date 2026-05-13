/**
 * Build-time types consumed by Flue's build pipeline.
 *
 * These types describe the inputs and outputs of `build()` and the plugin
 * surface that targets (Node, Cloudflare) implement. They are not part of
 * the runtime surface of `@flue/runtime` — they were extracted here when the
 * build/dev tooling moved from `@flue/sdk` into `@flue/cli` so the runtime
 * package would stop carrying tooling types.
 */
import type { Role } from '@flue/runtime';

export interface AgentInfo {
	name: string;
	filePath: string;
	triggers: { webhook?: boolean };
}

export interface BuildContext {
	agents: AgentInfo[];
	roles: Record<string, Role>;
	/**
	 * The project root — typically the user's cwd. Source files
	 * (agents/, roles/) live here directly, or under `<root>/.flue/`
	 * if that directory exists (the `.flue/`-as-src layout).
	 */
	root: string;
	/**
	 * Absolute path to the directory the build writes its artifacts into.
	 * Defaults to `<root>/dist`; users can override with `--output`
	 * (CLI) or `output` (programmatic) to redirect the build elsewhere.
	 *
	 * Note that this is the literal output directory — `server.mjs`,
	 * `wrangler.jsonc`, etc. are written directly inside it. The user's
	 * `wrangler.jsonc` and the wrangler deploy-redirect file still anchor
	 * on `root`, regardless of this value.
	 */
	output: string;
	/**
	 * Absolute path to the user's `app.{ts,js,mts,mjs}` entry, if one
	 * exists in the source root. When set, the generated server entry
	 * imports the user's app and dispatches all requests through its
	 * `fetch` method instead of constructing a default Hono app. When
	 * undefined, the generated entry falls back to a default Hono app
	 * with Flue's built-in routes mounted via `flue()`.
	 *
	 * Discovery follows the same extension priority as agents:
	 * `app.ts` > `app.mts` > `app.js` > `app.mjs`.
	 */
	appEntry?: string;
	options: BuildOptions;
}

/**
 * Controls the build output format for a target platform.
 *
 * A plugin can either ship a fully-bundled JavaScript artifact (Node target)
 * or hand over a TypeScript/ESM entry source that some downstream tool will
 * bundle (Cloudflare target — wrangler does the bundling). Pre-bundling on
 * top of a tool that bundles for itself causes subtle resolution conflicts
 * (we hit this with `tar`/`fs`/etc. via `nodejs_compat`), so the Cloudflare
 * path explicitly opts out.
 */
export interface BuildPlugin {
	name: string;
	/**
	 * The source of the entry point (TS or JS). May be async — the Cloudflare
	 * plugin reads the user's wrangler config (via wrangler's reader) which is
	 * a sync call but lives behind a lazy `await import('wrangler')`.
	 */
	generateEntryPoint(ctx: BuildContext): string | Promise<string>;
	/**
	 * Bundling strategy:
	 *   - `'esbuild'` (default): run the CLI's esbuild pass to produce a
	 *     bundled `dist/server.mjs`. Use when the deploy target is "just run
	 *     this file" with no further bundling step.
	 *   - `'none'`: skip esbuild. The entry is written as-is to `dist/` and
	 *     becomes the input for whatever tool will deploy it (e.g. wrangler).
	 *     The plugin must also implement `entryFilename` to set the file name.
	 */
	bundle?: 'esbuild' | 'none';
	/**
	 * The filename to use for the entry, written under `dist/`. Required when
	 * `bundle === 'none'`. For `bundle === 'esbuild'` the output is always
	 * `server.mjs` and this field is ignored.
	 */
	entryFilename?: string;
	/** esbuild options. Only consulted when `bundle === 'esbuild'`. */
	esbuildOptions?(ctx: BuildContext): Record<string, any>;
	/**
	 * Additional files to write to the output directory (`ctx.output`).
	 * Keys are filenames relative to `output` (e.g. `wrangler.jsonc`,
	 * `Dockerfile`). Values are file contents. May be async.
	 */
	additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
}

export interface BuildOptions {
	/**
	 * The project root — typically the cwd of the `flue` invocation.
	 *
	 * Source files (agents, roles) are discovered from `<root>/.flue/`
	 * if that directory exists, otherwise from `<root>/` directly.
	 * The two layouts never mix — `.flue/` wins unconditionally if present.
	 */
	root: string;
	/**
	 * Where the build artifacts are written. Defaults to `<root>/dist`.
	 * Pass an absolute or root-relative path to redirect the build
	 * somewhere else (e.g. when integrating with another build system that
	 * expects a specific directory). Resolved relative to the cwd at call
	 * time, not `root`.
	 */
	output?: string;
	target?: 'node' | 'cloudflare';
	/** Overrides `target` when provided. */
	plugin?: BuildPlugin;
}
