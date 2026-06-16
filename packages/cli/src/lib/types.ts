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

export interface ChannelInfo {
	name: string;
	filePath: string;
}

export interface BuildContext {
	agents: AgentInfo[];
	workflows: WorkflowInfo[];
	channels: ChannelInfo[];
	/** The project root — typically the user's cwd. */
	root: string;
	/**
	 * Absolute path to the directory the build writes its artifacts into.
	 * Defaults to `<root>/dist`; users can override with `--output`
	 * (CLI) or `output` (programmatic) to redirect the build elsewhere.
	 *
	 * Note that this is the literal output directory — `server.mjs` and
	 * other artifacts are written directly inside it. Cloudflare's
	 * generated Vite inputs (`<root>/.flue-vite/` and the composed
	 * `<root>/.flue-vite.wrangler.jsonc`) always anchor on `root`,
	 * regardless of this value.
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
	/**
	 * Absolute path to the user's `db.{ts,js,mts,mjs}` entry, if one
	 * exists in the source root. When set, the generated server entry
	 * imports the default export (a `PersistenceAdapter`), calls
	 * `await adapter.migrate()` to ensure schema, then awaits
	 * `adapter.connect()` once to obtain the execution, run, and
	 * event-stream stores.
	 * When undefined, the generated entry falls back to the platform
	 * default (Node: in-memory SQLite, Cloudflare: DO SQLite).
	 *
	 * Discovery follows the same extension priority as agents:
	 * `db.ts` > `db.mts` > `db.js` > `db.mjs`.
	 */
	dbEntry?: string;
	/** Version of @flue/runtime resolved for this build. */
	runtimeVersion: string;
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
	 * Keys are filenames relative to `output` (e.g. `Dockerfile`). Values
	 * are file contents. May be async.
	 */
	additionalOutputs?(ctx: BuildContext): Record<string, string> | Promise<Record<string, string>>;
	/**
	 * Inputs for the `'vite-cloudflare'` strategy. Required when
	 * `bundle === 'vite-cloudflare'`; ignored otherwise. May be async.
	 */
	viteInputs?(ctx: BuildContext): ViteCloudflareInputs | Promise<ViteCloudflareInputs>;
}

/** Generated inputs consumed by the official Cloudflare Vite integration. */
export interface ViteCloudflareInputs {
	/**
	 * Composed wrangler config contents, written to
	 * `<root>/.flue-vite.wrangler.jsonc` at the project root so official
	 * local variable discovery continues to find `.dev.vars` and `.env`.
	 */
	wranglerConfig: string;
	/**
	 * Extra files written next to the generated entry in `<root>/.flue-vite/`.
	 * Keys are filenames relative to that directory.
	 */
	entryDirFiles?: Record<string, string>;
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
	/** Controls human build progress output. Defaults to `normal`. */
	log?: 'normal' | 'silent';
	configFile?: string;
	envFile?: string;
}
