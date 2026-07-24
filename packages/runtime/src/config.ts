/**
 * `@flue/runtime/config` — the host-independent Flue project configuration.
 *
 * `flue.config.ts` describes a Flue *project* (not a deployment host): which
 * target it builds for, where its entry modules live, and which files the
 * `'use agent'` scan covers. Both hosts consume it:
 *
 *   - the `@flue/vite` plugin auto-discovers it (inline `flue(config)` values
 *     merged over the file via {@link mergeFlueConfig}), and
 *   - `flue run <path>` reads it directly.
 *
 * This module is host-side tooling (it touches the filesystem); import it
 * from build/CLI code, never from agent modules.
 *
 * Config-module evaluation: {@link loadFlueConfig} evaluates the config file
 * with the host's native dynamic `import()`, which handles plain JS, ESM, and
 * TypeScript via Node's type-stripping (Node ≥ 22.18 / ≥ 23.6). A host with
 * its own module loader (e.g. a Vite plugin evaluating through the module
 * runner, or one that must honor TS syntax that type-stripping rejects) can
 * instead evaluate the module itself and validate the raw default export with
 * {@link parseFlueConfig}.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';

// ─── Authoring API ──────────────────────────────────────────────────────────

/**
 * Configuration authored in `flue.config.ts`. Only the fields declared by
 * this interface are accepted.
 */
export interface FlueConfig {
	/**
	 * Build and development target.
	 *
	 * - `'node'` builds a Node.js server.
	 * - `'cloudflare'` builds a Workers-compatible application.
	 *
	 * Optional: the Vite plugin auto-detects `'cloudflare'` from the presence
	 * of the `@cloudflare/vite-plugin` sibling when unset; `flue run` is
	 * always Node-local.
	 */
	target?: 'node' | 'cloudflare';
	/**
	 * Path to the application entry (`app.ts`), the project's route map.
	 * Relative values resolve from the config file's directory. Defaults to
	 * the source-root lookup (see {@link resolveSourceRoot} and
	 * {@link discoverProjectEntry}). The resolved file must exist — an
	 * explicit path that doesn't is an error.
	 */
	app?: string;
	/**
	 * Path to the persistence entry (`db.ts`); Node hosts only. Same
	 * resolution rules as {@link FlueConfig.app}.
	 */
	db?: string;
	/**
	 * Path to the non-HTTP Cloudflare handlers entry (`cloudflare.ts`). Same
	 * resolution rules as {@link FlueConfig.app}.
	 */
	cloudflare?: string;
	/**
	 * Glob narrowing the `'use agent'` scan, relative to the source root
	 * (`.flue/`, `src/`, or the project root — whichever resolves). Defaults
	 * to the whole source root, recursively. Passed through verbatim for the
	 * scanner to interpret.
	 */
	agents?: string;
	/**
	 * Built-in pi-ai providers registered at server start, by provider ID
	 * (`['anthropic', 'openai']`). Each entry maps to a
	 * `@earendil-works/pi-ai/providers/<id>` factory import in the generated
	 * entry, so only the listed providers ship in the build. Omitted registers
	 * every built-in provider. Custom providers are unaffected — register
	 * those with `setProvider()` in `app.ts`.
	 */
	providers?: string[];
}

/**
 * Provides type checking and editor completion for `flue.config.ts`. Returns
 * the configuration unchanged.
 *
 * ```ts
 * import { defineConfig } from '@flue/runtime/config';
 *
 * export default defineConfig({
 *   target: 'node',
 * });
 * ```
 */
export function defineConfig(config: FlueConfig): FlueConfig {
	return config;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const NonEmptyPathSchema = v.pipe(v.string(), v.minLength(1, 'Path must not be empty.'));

const ProviderIdSchema = v.pipe(
	v.string(),
	// Provider IDs become `@earendil-works/pi-ai/providers/<id>` import
	// specifiers in generated code; reject anything that couldn't be one.
	v.regex(/^[a-z0-9][a-z0-9-]*$/, 'Provider IDs are lowercase alphanumerics and dashes.'),
);

const FlueConfigSchema = v.strictObject({
	target: v.optional(v.picklist(['node', 'cloudflare'] as const)),
	app: v.optional(NonEmptyPathSchema),
	db: v.optional(NonEmptyPathSchema),
	cloudflare: v.optional(NonEmptyPathSchema),
	agents: v.optional(NonEmptyPathSchema),
	providers: v.optional(v.array(ProviderIdSchema)),
});

/**
 * Validate a raw config value (a config module's default export, or inline
 * plugin options). Throws with per-field diagnostics naming `source`
 * (a config-file path, `"inline options"`, …).
 */
export function parseFlueConfig(value: unknown, source = 'flue config'): FlueConfig {
	if (value == null || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error(`[flue] ${source} must be a config object.`);
	}
	const result = v.safeParse(FlueConfigSchema, value);
	if (!result.success) {
		const lines = [`[flue] Invalid config in ${source}:`];
		for (const issue of result.issues) {
			const dotPath = v.getDotPath(issue);
			lines.push(dotPath ? `  • ${dotPath}: ${issue.message}` : `  • ${issue.message}`);
		}
		throw new Error(lines.join('\n'));
	}
	return result.output;
}

/**
 * Merge inline (host-provided) config over a discovered file config,
 * per-field. `undefined` inline fields fall through to the file value.
 */
export function mergeFlueConfig(file: FlueConfig, inline: FlueConfig): FlueConfig {
	return {
		target: inline.target ?? file.target,
		app: inline.app ?? file.app,
		db: inline.db ?? file.db,
		cloudflare: inline.cloudflare ?? file.cloudflare,
		agents: inline.agents ?? file.agents,
		providers: inline.providers ?? file.providers,
	};
}

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Config file basenames searched, in priority order. TypeScript first because
 * Flue's audience writes TS agents; the rest mirror Vite's supported set.
 */
export const FLUE_CONFIG_BASENAMES = Object.freeze([
	'flue.config.ts',
	'flue.config.mts',
	'flue.config.mjs',
	'flue.config.js',
	'flue.config.cjs',
	'flue.config.cts',
]);

export interface ResolveFlueConfigPathOptions {
	/** Directory to search for `flue.config.*`, and base for `configFile`. */
	cwd: string;
	/** Explicit config-file path (relative to `cwd`, or absolute). */
	configFile?: string;
}

/**
 * Resolve the absolute path of the project's `flue.config.*` file, or
 * `undefined` when none exists and none was asked for.
 *
 * Throws if `configFile` is an explicit path that doesn't exist on disk —
 * that's a typo, not a "config not configured" situation.
 */
export function resolveFlueConfigPath(opts: ResolveFlueConfigPathOptions): string | undefined {
	const cwd = path.resolve(opts.cwd);
	if (opts.configFile) {
		const explicit = path.resolve(cwd, opts.configFile);
		if (!fs.existsSync(explicit)) {
			throw new Error(`[flue] Config file not found: ${opts.configFile}`);
		}
		return explicit;
	}

	for (const basename of FLUE_CONFIG_BASENAMES) {
		const candidate = path.join(cwd, basename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

// ─── Loading ────────────────────────────────────────────────────────────────

export interface LoadedFlueConfig {
	/** Absolute path of the loaded config file, or `undefined` if none. */
	configPath: string | undefined;
	/** The validated config ({} when no config file exists). */
	config: FlueConfig;
}

/**
 * Discover, evaluate, and validate the project's `flue.config.*`.
 *
 * Evaluation uses the host's native dynamic `import()`: plain JS, ESM, and
 * TypeScript via Node's type-stripping (Node ≥ 22.18 / ≥ 23.6 enable this by
 * default). Hosts with their own module loader should evaluate the file
 * themselves and validate with {@link parseFlueConfig} instead.
 *
 * Cache-busts via a query param so repeated loads (e.g. a dev-server config
 * watcher) get a fresh module instead of the cached one.
 */
export async function loadFlueConfig(
	opts: ResolveFlueConfigPathOptions,
): Promise<LoadedFlueConfig> {
	const configPath = resolveFlueConfigPath(opts);
	if (!configPath) return { configPath: undefined, config: {} };
	const configModule = await loadFlueConfigModule(configPath);
	const source = path.relative(path.resolve(opts.cwd), configPath) || configPath;
	const raw = configModule.default;
	if (raw == null || typeof raw !== 'object') {
		throw new Error(`[flue] ${source} must export a config object as the default export.`);
	}
	return { configPath, config: parseFlueConfig(raw, source) };
}

/**
 * Load a config file's module namespace via native dynamic `import()`.
 * Errors that come out of strip-mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`)
 * are repackaged with a hint pointing at the constraint, since the original
 * Node message is terse.
 */
export async function loadFlueConfigModule(
	absConfigPath: string,
): Promise<Record<string, unknown>> {
	const fileUrl = `${pathToFileURL(absConfigPath).href}?t=${Date.now()}`;
	try {
		return await import(fileUrl);
	} catch (err) {
		const code = (err as { code?: string }).code;
		if (code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX') {
			throw new Error(
				`[flue] ${path.basename(absConfigPath)} uses TypeScript syntax that Node's ` +
					`type-stripping loader doesn't support (e.g. \`enum\`, \`namespace\` with ` +
					`runtime code, parameter properties, decorators). Rewrite using only ` +
					`erasable types (or move the config to plain JS).\n  Original: ${(err as Error).message}`,
			);
		}
		if (code === 'ERR_UNKNOWN_FILE_EXTENSION') {
			throw new Error(
				`[flue] Cannot load ${path.basename(absConfigPath)}: this Node ` +
					`(v${process.versions.node}) does not support TypeScript natively. ` +
					`Upgrade to Node ≥ 22.18 or ≥ 23.6.`,
			);
		}
		throw err;
	}
}

// ─── Source-root and entry lookup ───────────────────────────────────────────

/**
 * The directory authored modules are discovered from: `<root>/.flue` when it
 * exists as a directory, otherwise `<root>/src`, otherwise `<root>` itself.
 */
export function resolveSourceRoot(root: string): string {
	for (const sourceDirectory of ['.flue', 'src']) {
		const candidate = path.join(root, sourceDirectory);
		try {
			if (fs.statSync(candidate).isDirectory()) return candidate;
		} catch {}
	}
	return root;
}

/** Entry-module extensions, in lookup priority order. */
export const PROJECT_ENTRY_EXTENSIONS = Object.freeze(['ts', 'mts', 'js', 'mjs']);

/**
 * Locate `<sourceRoot>/<basename>.<ext>` for the default entry lookup
 * (`app`, `db`, `cloudflare`), honoring the extension priority
 * {@link PROJECT_ENTRY_EXTENSIONS}. Returns `undefined` when absent.
 */
export function discoverProjectEntry(sourceRoot: string, basename: string): string | undefined {
	for (const ext of PROJECT_ENTRY_EXTENSIONS) {
		const candidate = path.join(sourceRoot, `${basename}.${ext}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

// ─── Project resolution ─────────────────────────────────────────────────────

export interface ResolveFlueProjectOptions {
	/** Absolute (or cwd-relative) project root. */
	root: string;
	/** The (merged) config to resolve. Defaults to `{}`. */
	config?: FlueConfig;
	/**
	 * Path of the config file the values came from; relative config paths
	 * resolve from its directory. Defaults to resolving from `root`.
	 */
	configPath?: string;
}

/** A Flue project's fully resolved filesystem layout. */
export interface ResolvedFlueProject {
	/** Absolute project root. */
	root: string;
	/** Absolute directory authored modules are discovered from. */
	sourceRoot: string;
	/** Selected target, when configured. */
	target: 'node' | 'cloudflare' | undefined;
	/** Absolute `app.*` entry path, or `undefined` when none exists. */
	app: string | undefined;
	/** Absolute `db.*` entry path, or `undefined` when none exists. */
	db: string | undefined;
	/** Absolute `cloudflare.*` entry path, or `undefined` when none exists. */
	cloudflare: string | undefined;
	/** The `'use agent'` scan glob, verbatim as authored (root-relative). */
	agents: string | undefined;
	/** Built-in provider IDs to register, or `undefined` for all built-ins. */
	providers: string[] | undefined;
}

/**
 * Resolve a validated config against the filesystem: source-root lookup
 * (`.flue/` → `src/` → root) plus entry discovery with the `ts > mts > js >
 * mjs` extension priority. Explicit entry paths resolve from the config
 * file's directory and must exist (a typo, not a "not configured" state);
 * unset entries fall back to the source-root lookup and may be absent.
 *
 * Whether a missing entry is an error is the host's call (e.g. the Vite
 * plugin requires `app`; `flue run` requires none).
 */
export function resolveFlueProject(opts: ResolveFlueProjectOptions): ResolvedFlueProject {
	const root = path.resolve(opts.root);
	const config = opts.config ?? {};
	const baseDir = opts.configPath ? path.dirname(path.resolve(opts.configPath)) : root;
	const sourceRoot = resolveSourceRoot(root);
	return {
		root,
		sourceRoot,
		target: config.target,
		app: resolveEntry('app', config.app, baseDir, sourceRoot),
		db: resolveEntry('db', config.db, baseDir, sourceRoot),
		cloudflare: resolveEntry('cloudflare', config.cloudflare, baseDir, sourceRoot),
		agents: config.agents,
		providers: config.providers,
	};
}

function resolveEntry(
	field: 'app' | 'db' | 'cloudflare',
	configured: string | undefined,
	baseDir: string,
	sourceRoot: string,
): string | undefined {
	if (configured !== undefined) {
		const explicit = path.resolve(baseDir, configured);
		if (!fs.existsSync(explicit)) {
			throw new Error(`[flue] Configured \`${field}\` entry not found: ${configured}`);
		}
		return explicit;
	}
	return discoverProjectEntry(sourceRoot, field);
}
