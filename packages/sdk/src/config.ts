/**
 * Flue config file support — `flue.config.{ts,mts,mjs,js,cjs,cts}`.
 *
 * Modeled on Vite/Astro:
 *
 *   - The config file lives at the project root. Its directory IS the root for
 *     the purposes of resolving any relative paths it sets (`workspace`,
 *     `output`).
 *   - Discovery: `--config <path>` (resolved vs. cwd) wins; otherwise we search
 *     a starting directory (`--workspace` if given, else cwd) for any of the
 *     supported extensions, in order.
 *   - Loading: plain Node dynamic `import()`. We rely on Node's native
 *     TypeScript type-stripping (Node ≥ 22.18 / ≥ 23.6 by default) to handle
 *     `.ts` configs. We deliberately do NOT bundle the config — `flue.config`
 *     is a flat declarative surface, and "what valid TS works" should match
 *     the same rules the user already absorbed for the rest of the runtime.
 *     The CLI bin pre-checks the Node version before we ever get here, so
 *     `ERR_UNKNOWN_FILE_EXTENSION` shouldn't surface in practice.
 *   - Validation: valibot schema on the user-facing shape.
 *   - Resolution: CLI inline > config file > built-in defaults. CLI flags
 *     always win on a per-field basis — only the fields the user actually
 *     passed get to override the file.
 *
 * The two public types mirror Astro's `AstroUserConfig` / `AstroConfig`
 * split: `UserFlueConfig` is what users author (everything optional);
 * `FlueConfig` is the resolved shape with required defaults filled in.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * User-facing config shape — everything optional so `defineConfig({})` is
 * valid. Defaults are filled in at resolution time. Modeled on Astro's
 * `AstroUserConfig`.
 */
export interface UserFlueConfig {
	/**
	 * Build target. Required somewhere — either here or via `--target`.
	 */
	target?: 'node' | 'cloudflare';
	/**
	 * Workspace dir (project root in Vite parlance — to be renamed `root`
	 * in a future release). Relative paths are resolved vs. the directory
	 * containing the config file. Defaults to that directory if unset.
	 */
	workspace?: string;
	/**
	 * Build output dir. Relative paths are resolved vs. the directory
	 * containing the config file. Defaults to `<workspace>/dist`.
	 */
	output?: string;
}

/**
 * Resolved config — what the rest of the SDK consumes. All paths are
 * absolute; all required fields are present.
 */
export interface FlueConfig {
	target: 'node' | 'cloudflare';
	/** Absolute path. */
	workspace: string;
	/** Absolute path. */
	output: string;
}

/**
 * Identity helper for type inference and editor intellisense, à la Vite's
 * `defineConfig`. Returns its argument unchanged.
 *
 * ```ts
 * import { defineConfig } from '@flue/sdk/config';
 * export default defineConfig({ target: 'node' });
 * ```
 */
export function defineConfig(config: UserFlueConfig): UserFlueConfig {
	return config;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const TargetSchema = v.picklist(['node', 'cloudflare'] as const);

const UserFlueConfigSchema = v.strictObject({
	target: v.optional(TargetSchema),
	workspace: v.optional(v.string()),
	output: v.optional(v.string()),
});

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Config file basenames searched, in priority order. TypeScript first because
 * Flue's audience writes TS agents; the rest mirror Vite's supported set.
 */
const CONFIG_BASENAMES = Object.freeze([
	'flue.config.ts',
	'flue.config.mts',
	'flue.config.mjs',
	'flue.config.js',
	'flue.config.cjs',
	'flue.config.cts',
]);

export interface ResolveConfigPathOptions {
	/** Where to start searching when `configFile` is not set. */
	cwd: string;
	/**
	 * Explicit config-file path (relative to `cwd`, or absolute), or `false`
	 * to disable config loading entirely. Mirrors Astro's
	 * `AstroInlineOnlyConfig.configFile`.
	 */
	configFile?: string | false;
}

/**
 * Resolve the absolute path of the user's `flue.config.*` file, or
 * `undefined` if none is found and the user didn't ask for one.
 *
 * Throws if `configFile` is an explicit path that doesn't exist on disk —
 * that's a typo, not a "config not configured" situation.
 */
export function resolveConfigPath(opts: ResolveConfigPathOptions): string | undefined {
	if (opts.configFile === false) return undefined;

	if (opts.configFile) {
		const explicit = path.isAbsolute(opts.configFile)
			? opts.configFile
			: path.resolve(opts.cwd, opts.configFile);
		if (!fs.existsSync(explicit)) {
			throw new Error(`[flue] Config file not found: ${opts.configFile}`);
		}
		return explicit;
	}

	for (const basename of CONFIG_BASENAMES) {
		const candidate = path.join(opts.cwd, basename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

// ─── Loading ────────────────────────────────────────────────────────────────

/**
 * Load a config file's `default` export. We rely on Node's native dynamic
 * `import()` for everything: plain JS, ESM, and TypeScript via type-stripping
 * (Node ≥ 22.18 / ≥ 23.6 enable this by default). The CLI's bin entrypoint
 * pre-validates the Node version, so by the time we reach this function the
 * runtime is known to support the formats we accept.
 *
 * Cache-bust via a query param so repeated loads (e.g. a future dev-server
 * config-watcher) get a fresh module instead of the cached one.
 *
 * Errors that come out of strip-mode (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`)
 * are repackaged with a hint pointing at the constraint, since the original
 * Node message is terse.
 *
 * Returns the raw module default — caller is responsible for validation.
 */
async function loadConfigModule(absConfigPath: string): Promise<unknown> {
	const fileUrl = pathToFileURL(absConfigPath).href + `?t=${Date.now()}`;
	try {
		const mod = await import(fileUrl);
		return mod.default ?? mod;
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
			// Should be unreachable — the CLI bin precheck enforces a Node
			// version that supports `.ts` natively. Surface a useful hint
			// anyway in case someone bypasses the bin (e.g. consumes the SDK
			// directly on an old Node).
			throw new Error(
				`[flue] Cannot load ${path.basename(absConfigPath)}: this Node ` +
					`(v${process.versions.node}) does not support TypeScript natively. ` +
					`Upgrade to Node ≥ 22.18 or ≥ 23.6.`,
			);
		}
		throw err;
	}
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolveConfigOptions {
	/** Working directory of the CLI invocation; default search base. */
	cwd: string;
	/**
	 * Optional starting directory to search for the config. If unset, falls
	 * back to `cwd`. Used when the CLI received `--workspace` and we want to
	 * look for a config inside that directory rather than cwd. Vite has the
	 * same behavior with `--root`.
	 */
	searchFrom?: string;
	/** Explicit `--config` value, or `false` to skip loading. */
	configFile?: string | false;
	/**
	 * Inline overrides from the CLI. Only fields the user actually passed
	 * should be present — `undefined` means "fall through to the config file
	 * value or the default".
	 */
	inline?: UserFlueConfig;
}

export interface ResolvedConfigResult {
	/** Absolute path of the loaded config file, or undefined if none. */
	configPath: string | undefined;
	/** The merged-but-unresolved user config (config file + inline). */
	userConfig: UserFlueConfig;
	/** The fully-resolved config consumed by the rest of the SDK. */
	flueConfig: FlueConfig;
}

/**
 * Discover, load, validate, merge, and resolve a Flue config. The single
 * entry point CLIs and embedders call.
 *
 * Precedence (highest first):
 *   1. CLI inline values (`opts.inline.*`)
 *   2. `flue.config.ts`
 *   3. Built-in defaults
 *
 * Throws if validation fails or if no `target` is supplied anywhere.
 */
export async function resolveConfig(opts: ResolveConfigOptions): Promise<ResolvedConfigResult> {
	const cwd = path.resolve(opts.cwd);
	const searchFrom = path.resolve(opts.searchFrom ?? cwd);

	const configPath = resolveConfigPath({ cwd: searchFrom, configFile: opts.configFile });

	let fileConfig: UserFlueConfig = {};
	if (configPath) {
		const raw = await loadConfigModule(configPath);
		if (raw == null || typeof raw !== 'object') {
			throw new Error(
				`[flue] ${path.relative(cwd, configPath) || configPath} must export a config object as the default export.`,
			);
		}
		const result = v.safeParse(UserFlueConfigSchema, raw);
		if (!result.success) {
			throw new Error(formatValidationError(configPath, result.issues));
		}
		fileConfig = result.output;
	}

	// The "config root" — the directory we resolve relative paths in the config
	// file against. If there's no config file, this is just the search dir; in
	// practice it's never observed because relative paths only matter when a
	// file set them.
	const configDir = configPath ? path.dirname(configPath) : searchFrom;

	const inline = opts.inline ?? {};

	// Merge: per-field, inline > file. We don't merge nested structures because
	// the surface is flat today.
	const merged: UserFlueConfig = {
		target: inline.target ?? fileConfig.target,
		workspace: inline.workspace ?? fileConfig.workspace,
		output: inline.output ?? fileConfig.output,
	};

	// Resolve target. The one field with no sensible default — surface a clear
	// error pointing the user at both available knobs.
	if (!merged.target) {
		throw new Error(
			'[flue] Missing required `target`. Set it via `--target <node|cloudflare>` ' +
				'or in `flue.config.ts` as `target: "node"` (or `"cloudflare"`).',
		);
	}

	// Resolve workspace. Inline values were already absolutized by the CLI;
	// file values are resolved vs. the config dir; default is the config dir
	// (or searchFrom if no config). All paths emerge absolute.
	const workspace = resolvePath(merged.workspace, {
		fromConfig: !!fileConfig.workspace && inline.workspace === undefined,
		configDir,
		fallback: configDir,
	});

	// Resolve output the same way; default is `<workspace>/dist`.
	const output = resolvePath(merged.output, {
		fromConfig: !!fileConfig.output && inline.output === undefined,
		configDir,
		fallback: path.join(workspace, 'dist'),
	});

	return {
		configPath,
		userConfig: merged,
		flueConfig: { target: merged.target, workspace, output },
	};
}

/**
 * Resolve a possibly-relative path to an absolute one.
 *
 * - If `value` is undefined, returns `fallback`.
 * - If `value` is absolute, returns it as-is.
 * - If `value` is relative AND came from the config file, resolves vs. the
 *   config dir.
 * - If `value` is relative AND came from the CLI, the CLI is responsible for
 *   already having absolutized it (`path.resolve` against cwd at parse time)
 *   — this branch is defensive and resolves against `process.cwd()`.
 */
function resolvePath(
	value: string | undefined,
	opts: { fromConfig: boolean; configDir: string; fallback: string },
): string {
	if (!value) return opts.fallback;
	if (path.isAbsolute(value)) return value;
	if (opts.fromConfig) return path.resolve(opts.configDir, value);
	return path.resolve(value);
}

function formatValidationError(configPath: string, issues: readonly v.BaseIssue<unknown>[]): string {
	const lines = [`[flue] Invalid config in ${configPath}:`];
	for (const issue of issues) {
		const dotPath = v.getDotPath(issue);
		const where = dotPath ? `  • ${dotPath}: ` : '  • ';
		lines.push(`${where}${issue.message}`);
	}
	return lines.join('\n');
}
