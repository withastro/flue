/**
 * Configure how the Flue CLI finds and builds a project.
 *
 * Use {@link defineConfig} in a `flue.config.ts` file for type checking and
 * editor completion.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as v from 'valibot';
import { CONFIG_BASENAMES } from './config-paths.ts';
import { resolveSourceRoot } from './source-root.ts';
import {
	BUILT_IN_PROVIDERS,
	type BuiltInProvider,
} from './vite-pi-ai-provider-allowlist-plugin.ts';

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Configuration authored in `flue.config.ts`. Only the fields declared by
 * this interface are accepted.
 */
export interface UserFlueConfig {
	/**
	 * Build and development target. Required unless `--target` is passed to the
	 * CLI. There is no default.
	 *
	 * - `'node'` builds a Node.js server.
	 * - `'cloudflare'` builds a Workers-compatible application.
	 */
	target?: 'node' | 'cloudflare';
	/**
	 * Project root. Must not be empty. Relative values loaded from a
	 * configuration file resolve from the directory containing that file;
	 * relative inline values resolve from the caller's working directory.
	 * Defaults to the config directory, or to the search directory when no
	 * configuration file is loaded.
	 *
	 * Flue uses `<root>/.flue` when it exists as a directory, otherwise
	 * `<root>/src` when it exists as a directory, otherwise `<root>`.
	 */
	root?: string;
	/**
	 * Build output directory. Must not be empty. Relative values loaded from a
	 * configuration file resolve from the directory containing that file;
	 * relative inline values resolve from the caller's working directory. Paths
	 * do not resolve from {@link UserFlueConfig.root}. Defaults to `<root>/dist`.
	 */
	output?: string;
	/**
	 * Built-in model providers whose SDK-backed transports are included in the
	 * artifact. Defaults to `[]`. Cloudflare builds include Flue's binding-backed
	 * `cloudflare/...` provider separately.
	 */
	providers?: BuiltInProvider[];
}

/** Fully resolved configuration returned by {@link resolveConfig}. */
export interface FlueConfig {
	/** Selected build and development target. */
	target: 'node' | 'cloudflare';
	/** Absolute project-root path. */
	root: string;
	/** Absolute directory from which authored modules are discovered. */
	sourceRoot: string;
	/** Absolute build-output path. */
	output: string;
	/** Built-in model providers whose SDK-backed transports are included in the build. */
	providers: BuiltInProvider[];
}

/**
 * Provides type checking and editor completion for `flue.config.ts`. Returns
 * the configuration unchanged.
 *
 * ```ts
 * import { defineConfig } from '@flue/cli/config';
 *
 * export default defineConfig({
 *   target: 'node',
 * });
 * ```
 */
export function defineConfig(config: UserFlueConfig): UserFlueConfig {
	return config;
}

// ─── Validation ─────────────────────────────────────────────────────────────

const TargetSchema = v.picklist(['node', 'cloudflare'] as const);

const BuiltInProviderSchema = v.picklist(BUILT_IN_PROVIDERS);

const NonEmptyPathSchema = v.pipe(v.string(), v.minLength(1, 'Path must not be empty.'));

const UserFlueConfigSchema = v.strictObject({
	target: v.optional(TargetSchema),
	root: v.optional(NonEmptyPathSchema),
	output: v.optional(NonEmptyPathSchema),
	providers: v.optional(v.array(BuiltInProviderSchema)),
});

// ─── Discovery ──────────────────────────────────────────────────────────────

/**
 * Config file basenames searched, in priority order. TypeScript first because
 * Flue's audience writes TS agents; the rest mirror Vite's supported set.
 */
export interface ResolveConfigPathOptions {
	/** Working directory for config discovery and relative `configFile` paths. */
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
 * `undefined` if none is found and the user didn't ask for one. Relative `cwd`
 * values resolve from the process working directory; relative `configFile`
 * values resolve from the normalized `cwd`.
 *
 * Throws if `configFile` is an explicit path that doesn't exist on disk —
 * that's a typo, not a "config not configured" situation.
 */
export function resolveConfigPath(opts: ResolveConfigPathOptions): string | undefined {
	if (opts.configFile === false) return undefined;

	const cwd = path.resolve(opts.cwd);
	if (opts.configFile) {
		const explicit = path.resolve(cwd, opts.configFile);
		if (!fs.existsSync(explicit)) {
			throw new Error(`[flue] Config file not found: ${opts.configFile}`);
		}
		return explicit;
	}

	for (const basename of CONFIG_BASENAMES) {
		const candidate = path.join(cwd, basename);
		if (fs.existsSync(candidate)) return candidate;
	}
	return undefined;
}

// ─── Loading ────────────────────────────────────────────────────────────────

/**
 * Load a config file's `default` export. We rely on Node's native dynamic
 * `import()` for everything: plain JS, ESM, and TypeScript via type-stripping
 * (Node ≥ 22.19 enables this by default). The CLI's bin entrypoint
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
	const fileUrl = `${pathToFileURL(absConfigPath).href}?t=${Date.now()}`;
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
			// anyway in case someone bypasses the bin (e.g. consumes the config
			// loader directly on an old Node).
			throw new Error(
				`[flue] Cannot load ${path.basename(absConfigPath)}: this Node ` +
					`(v${process.versions.node}) does not support TypeScript natively. ` +
					`Upgrade to Node ≥ 22.19.`,
			);
		}
		throw err;
	}
}

// ─── Resolution ─────────────────────────────────────────────────────────────

export interface ResolveConfigOptions {
	/** Caller's working directory; default search base for config discovery. */
	cwd: string;
	/**
	 * Optional starting directory for config discovery. Defaults to `cwd`.
	 * Relative values resolve from the process working directory.
	 */
	searchFrom?: string;
	/** Explicit config-file path relative to `cwd`, or `false` to skip loading. */
	configFile?: string | false;
	/**
	 * Inline overrides. Only fields the caller actually supplied should be
	 * present — `undefined` means "fall through to the config-file value or the
	 * default". Relative paths resolve from `cwd`.
	 */
	inline?: UserFlueConfig;
}

export interface ResolvedConfigResult {
	/** Absolute path of the loaded config file, or undefined if none. */
	configPath: string | undefined;
	/** The merged-but-unresolved user config (config file + inline). */
	userConfig: UserFlueConfig;
	/** The fully-resolved config consumed by the rest of the CLI. */
	flueConfig: FlueConfig;
}

/**
 * Discover, load, validate, merge, and resolve a Flue config. The single
 * entry point CLIs and embedders call.
 *
 * Precedence (highest first):
 *   1. Inline values (`opts.inline.*`)
 *   2. `flue.config.ts`
 *   3. Built-in defaults
 *
 * Throws if validation fails or if no `target` is supplied anywhere.
 */
export async function resolveConfig(opts: ResolveConfigOptions): Promise<ResolvedConfigResult> {
	const cwd = path.resolve(opts.cwd);
	const searchFrom = path.resolve(opts.searchFrom ?? cwd);

	// Explicit `--config <path>` is resolved relative to the caller's cwd
	// (matches the help text: "(relative to cwd)"). Auto-discovery still
	// scans `searchFrom` so `--root` continues to influence where we look
	// when no `--config` was provided.
	const configPath =
		opts.configFile !== undefined
			? resolveConfigPath({ cwd, configFile: opts.configFile })
			: resolveConfigPath({ cwd: searchFrom, configFile: undefined });

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

	const inlineResult = v.safeParse(UserFlueConfigSchema, opts.inline ?? {});
	if (!inlineResult.success) {
		throw new Error(formatValidationError('inline options', inlineResult.issues));
	}
	const inline = inlineResult.output;

	// Merge: per-field, inline > file. We don't merge nested structures because
	// the surface is flat today.
	const merged: UserFlueConfig = {
		target: inline.target ?? fileConfig.target,
		root: inline.root ?? fileConfig.root,
		output: inline.output ?? fileConfig.output,
		providers: inline.providers ?? fileConfig.providers,
	};

	// Resolve target. The one field with no sensible default — surface a clear
	// error pointing the user at both available knobs.
	if (!merged.target) {
		throw new Error(
			'[flue] Missing required `target`. Set it via `--target <node|cloudflare>` ' +
				'or in `flue.config.ts` as `target: "node"` (or `"cloudflare"`).',
		);
	}

	// Resolve root. Inline values resolve from cwd; file values resolve from the
	// config dir; default is the config dir (or searchFrom if no config). All
	// paths emerge absolute.
	const root = resolvePath(merged.root, {
		baseDir: inline.root === undefined ? configDir : cwd,
		fallback: configDir,
	});

	// Resolve output the same way; default is `<root>/dist`.
	const output = resolvePath(merged.output, {
		baseDir: inline.output === undefined ? configDir : cwd,
		fallback: path.join(root, 'dist'),
	});
	const sourceRoot = resolveSourceRoot(root);

	return {
		configPath,
		userConfig: merged,
		flueConfig: {
			target: merged.target,
			root,
			sourceRoot,
			output,
			providers: merged.providers ?? [],
		},
	};
}

/** Resolve a possibly-relative path to an absolute one. */
function resolvePath(
	value: string | undefined,
	opts: { baseDir: string; fallback: string },
): string {
	if (value === undefined) return opts.fallback;
	if (path.isAbsolute(value)) return value;
	return path.resolve(opts.baseDir, value);
}

function formatValidationError(
	configPath: string,
	issues: readonly v.BaseIssue<unknown>[],
): string {
	const lines = [`[flue] Invalid config in ${configPath}:`];
	for (const issue of issues) {
		const dotPath = v.getDotPath(issue);
		const where = dotPath ? `  • ${dotPath}: ` : '  • ';
		lines.push(`${where}${issue.message}`);
	}
	return lines.join('\n');
}
