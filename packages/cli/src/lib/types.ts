/**
 * Build-time types consumed by Flue's build pipeline.
 *
 * These types describe the inputs and outputs of `build()` and the plugin
 * surface that targets (Node, Cloudflare) implement. They are not part of
 * the runtime surface of `@flue/runtime` — they were extracted here when the
 * build/dev tooling moved from `@flue/sdk` into `@flue/cli` so the runtime
 * package would stop carrying tooling types.
 */
export interface AgentInfo {
	name: string;
	filePath: string;
}

export interface WorkflowInfo {
	name: string;
	filePath: string;
}

export interface BuildContext {
	agents: AgentInfo[];
	workflows: WorkflowInfo[];
	/** The project root — typically the user's cwd. */
	root: string;
	/**
	 * Absolute path to the directory the build writes its artifacts into.
	 * Defaults to `<root>/dist`; users can override with `--output`
	 * (CLI) or `output` (programmatic) to redirect the build elsewhere.
	 *
	 * Note that this is the literal output directory — `server.mjs`,
	 * `wrangler.jsonc`, etc. are written directly inside it. The user's
		 * Cloudflare's generated Vite input configuration and official-plugin
		 * deployment redirect still anchor on `root`, regardless of this value.

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
	cloudflareEntry?: string;
	/** Version of @flue/runtime resolved for this build. */
	runtimeVersion: string;
	options: BuildOptions;
}

/**
 * Controls the build output format for a target platform.
 *
 * A plugin can ship a JavaScript artifact bundled through the shared Vite
 * graph or use the official Cloudflare Vite integration.
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
	 *   - `'vite'`: build a Node `server.mjs` artifact through Flue's shared
	 *     Vite authored-module graph.
	 *   - `'vite-cloudflare'`: write the Cloudflare source entry used by the
	 *     official Cloudflare Vite integration.
	 */
	bundle: 'vite' | 'vite-cloudflare';
	/**
	 * The filename to use for the generated Cloudflare source entry. Required
	 * when `bundle === 'vite-cloudflare'`. Node bundled output is always
	 * `server.mjs` and ignores this field.
	 */
	entryFilename?: string;
	/** Package names that Vite should preserve as external runtime dependencies. */
	external?: string[];
	/**
	 * Additional files to write to the output directory (`ctx.output`).
	 * Keys are filenames relative to `output` (e.g. `wrangler.jsonc`,
	 * `Dockerfile`). Values are file contents. May be async.
	 */
	additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
}

export interface BuildOptions {
	/** The project root — typically the cwd of the `flue` invocation. */
	root: string;
	sourceRoot: string;
	/**
	 * Where the build artifacts are written. Defaults to `<root>/dist`.
	 * Pass an absolute or root-relative path to redirect the build
	 * somewhere else (e.g. when integrating with another build system that
	 * expects a specific directory). Resolved relative to the cwd at call
	 * time, not `root`.
	 */
	output?: string;
	target?: 'node' | 'cloudflare';
	mode?: 'build' | 'development';
	/** Overrides `target` when provided. */
	plugin?: BuildPlugin;
}
