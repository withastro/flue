/**
 * Flue config file support — `flue.config.{ts,mts,mjs,js,cjs,cts}`.
 *
 * Modeled on Vite/Astro:
 *
 *   - The config file lives at the project root. Its directory IS the root for
 *     the purposes of resolving any relative paths it sets (`root`, `output`).
 *   - Discovery: `--config <path>` (resolved vs. cwd) wins; otherwise we search
 *     a starting directory (`--root` if given, else cwd) for any of the
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
 * Brand applied to every value returned from a `defineXxxModel(...)` helper,
 * used as the discriminator inside `resolveModel`. Treat as opaque from
 * userland. The leading underscore + `__` keeps the field unobtrusive in
 * IDE autocomplete on the user-facing object.
 *
 * Bumping this string is a breaking change to the build artifact — old
 * entries in a stale `flue.config.ts` would no longer be recognized. Don't
 * bump it casually.
 */
const FLUE_MODEL_DEFINITION_BRAND = '__flueModelDefinition' as const;
export const FLUE_MODEL_DEFINITION_VERSION = 1 as const;

/**
 * Discriminated record produced by `defineOpenAICompletionsModel(...)`. The
 * `kind` field gates which branch of the resolver builds the pi-ai `Model`
 * literal. Static-object shape (no closures) so it survives JSON
 * serialization into the build artifact unchanged.
 */
export interface OpenAICompletionsModelDefinition {
	[FLUE_MODEL_DEFINITION_BRAND]: typeof FLUE_MODEL_DEFINITION_VERSION;
	kind: 'openai-completions';
	/**
	 * Provider name surfaced on AssistantMessage records and used as the
	 * `init({ providers: { ... } })` override key. Defaults to the prefix
	 * the entry was registered under in the `models` map.
	 */
	provider?: string;
	/** Endpoint root, e.g. `http://localhost:11434/v1`. Required. */
	baseUrl: string;
	/** Optional default headers merged into every request. */
	headers?: Record<string, string>;
}

/**
 * Internal-only model definition for the Cloudflare Workers AI binding.
 *
 * This kind has no public `defineXxxModel(...)` helper — it's not part of
 * the user-facing config surface. It exists so the cloudflare build plugin
 * can register `cloudflare/...` as a user model entry at build time, using
 * the same resolution path as `openai-completions`. This keeps the SDK from
 * needing a hardcoded reserved-prefix branch in `resolveModel`.
 *
 * If a user explicitly puts this kind in their `flue.config.ts`, valibot
 * will accept it (the schema covers it for symmetry), but they'd need to
 * construct the literal by hand — not supported, not documented.
 */
export interface CloudflareAIBindingModelDefinition {
	[FLUE_MODEL_DEFINITION_BRAND]: typeof FLUE_MODEL_DEFINITION_VERSION;
	kind: 'cloudflare-ai-binding';
}

/**
 * Construct the internal `cloudflare-ai-binding` definition. Used by the
 * Cloudflare build plugin to seed the user-models map at build time so
 * `cloudflare/...` model strings resolve through the same code path as
 * user-defined providers. Not exported to userland.
 */
export function createCloudflareAIBindingDefinition(): CloudflareAIBindingModelDefinition {
	return {
		[FLUE_MODEL_DEFINITION_BRAND]: FLUE_MODEL_DEFINITION_VERSION,
		kind: 'cloudflare-ai-binding',
	};
}

/**
 * Union of every shape produced by Flue's model-definition helpers. New
 * helpers (e.g. for Anthropic-compatible custom endpoints) extend this
 * union, and `resolveModel` adds a corresponding branch.
 */
export type FlueModelDefinition =
	| OpenAICompletionsModelDefinition
	| CloudflareAIBindingModelDefinition;

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
	 * Project root. Source files (`agents/`, `roles/`) live here directly,
	 * or under `<root>/.flue/`. Relative paths are resolved vs. the
	 * directory containing the config file (Vite-style: the config file's
	 * dir IS the root by default). Defaults to that directory if unset.
	 */
	root?: string;
	/**
	 * Build output dir. Relative paths are resolved vs. the directory
	 * containing the config file. Defaults to `<root>/dist`.
	 */
	output?: string;
	/**
	 * User-defined model providers. Keys are bare provider names without
	 * any slash (e.g. `"ollama"`, `"lmstudio"`); values come from a
	 * `defineXxxModel(...)` helper.
	 *
	 * At resolve time, `init({ model: 'ollama/llama3.1:8b' })` matches
	 * the `ollama` key; the part after the first slash is forwarded to the
	 * underlying provider as the model id.
	 *
	 * User-defined entries are consulted before the pi-ai catalog.
	 * Last-write-wins on collision — same semantics as pi-ai's own
	 * `registerApiProvider`. Use that to override a built-in if you need
	 * to.
	 *
	 * On the Cloudflare target, an internal `cloudflare:` entry is
	 * auto-injected at build time so that `init({ model: 'cloudflare/...' })`
	 * routes through the Workers AI binding. A user-supplied `cloudflare:`
	 * entry shadows that default.
	 */
	models?: Record<string, FlueModelDefinition>;
}

/**
 * Resolved config — what the rest of the SDK consumes. All paths are
 * absolute; all required fields are present.
 */
export interface FlueConfig {
	target: 'node' | 'cloudflare';
	/** Absolute path. */
	root: string;
	/** Absolute path. */
	output: string;
	/**
	 * User-defined model providers, keyed by bare provider name (no slash).
	 * Always present (defaults to `{}`) so consumers don't need to null-check.
	 */
	models: Record<string, FlueModelDefinition>;
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

/**
 * Declare an OpenAI-compatible completions endpoint as a Flue model
 * provider. Use this for Ollama, LM Studio, vLLM, llama.cpp, LiteLLM,
 * any vendor that speaks the OpenAI Chat Completions wire format.
 *
 * ```ts
 * import { defineConfig, defineOpenAICompletionsModel } from '@flue/sdk/config';
 *
 * export default defineConfig({
 *   target: 'node',
 *   models: {
 *     ollama: defineOpenAICompletionsModel({
 *       baseUrl: 'http://localhost:11434/v1',
 *     }),
 *   },
 * });
 * ```
 *
 * Then in agent code: `init({ model: 'ollama/llama3.1:8b' })`.
 *
 * The `provider` defaults to the key the entry is registered under in the
 * `models` map; pass it explicitly if you want a different value to surface
 * on AssistantMessage records or as the `init({ providers: { ... } })`
 * override key.
 *
 * Returned objects are JSON-serializable on purpose — the build inlines
 * them into the generated server entry. Don't put functions or class
 * instances on them.
 */
export function defineOpenAICompletionsModel(opts: {
	baseUrl: string;
	provider?: string;
	headers?: Record<string, string>;
}): OpenAICompletionsModelDefinition {
	if (typeof opts.baseUrl !== 'string' || opts.baseUrl.length === 0) {
		throw new Error(
			'[flue] defineOpenAICompletionsModel: `baseUrl` is required (e.g. "http://localhost:11434/v1").',
		);
	}
	// `JSON.stringify` (used by the build plugins to inline this map) drops
	// undefined-valued keys, so unconditionally assigning the optionals is
	// equivalent to spreading them in only when set.
	return {
		[FLUE_MODEL_DEFINITION_BRAND]: FLUE_MODEL_DEFINITION_VERSION,
		kind: 'openai-completions',
		baseUrl: opts.baseUrl,
		provider: opts.provider,
		headers: opts.headers,
	};
}

// ─── Validation ─────────────────────────────────────────────────────────────

const TargetSchema = v.picklist(['node', 'cloudflare'] as const);

/**
 * Bare provider names. No slashes (slashes appear in the model string AFTER
 * the prefix and are routed to the underlying provider). Lower-kebab-case
 * with leading alphanumeric — matches the rest of pi-ai's provider slugs.
 */
const PROVIDER_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const OpenAICompletionsModelDefinitionSchema = v.strictObject({
	[FLUE_MODEL_DEFINITION_BRAND]: v.literal(FLUE_MODEL_DEFINITION_VERSION),
	kind: v.literal('openai-completions'),
	provider: v.optional(v.string()),
	baseUrl: v.string(),
	headers: v.optional(v.record(v.string(), v.string())),
});

const CloudflareAIBindingModelDefinitionSchema = v.strictObject({
	[FLUE_MODEL_DEFINITION_BRAND]: v.literal(FLUE_MODEL_DEFINITION_VERSION),
	kind: v.literal('cloudflare-ai-binding'),
});

const FlueModelDefinitionSchema = v.variant('kind', [
	OpenAICompletionsModelDefinitionSchema,
	CloudflareAIBindingModelDefinitionSchema,
]);

const ModelsSchema = v.pipe(
	v.record(v.string(), FlueModelDefinitionSchema),
	v.check(
		(models) => Object.keys(models).every((k) => PROVIDER_KEY_PATTERN.test(k)),
		`Each "models" key must be a bare provider name (e.g. "ollama") — no slashes, lower-kebab-case. ` +
			`The provider name is matched against the part of \`init({ model: '...' })\` ` +
			`before the first slash; the rest is forwarded to the provider as the model id.`,
	),
);

const UserFlueConfigSchema = v.strictObject({
	target: v.optional(TargetSchema),
	root: v.optional(v.string()),
	output: v.optional(v.string()),
	models: v.optional(ModelsSchema),
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
	 * back to `cwd`. Used when the CLI received `--root` and we want to look
	 * for a config inside that directory rather than cwd. Vite has the same
	 * behavior with `--root`.
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
	// the surface is flat today. `models` is whole-object replacement (no
	// shallow merge) — the CLI never sets `models` inline today, so this only
	// matters as a forward-compat note.
	const merged: UserFlueConfig = {
		target: inline.target ?? fileConfig.target,
		root: inline.root ?? fileConfig.root,
		output: inline.output ?? fileConfig.output,
		models: inline.models ?? fileConfig.models,
	};

	// Resolve target. The one field with no sensible default — surface a clear
	// error pointing the user at both available knobs.
	if (!merged.target) {
		throw new Error(
			'[flue] Missing required `target`. Set it via `--target <node|cloudflare>` ' +
				'or in `flue.config.ts` as `target: "node"` (or `"cloudflare"`).',
		);
	}

	// Resolve root. Inline values were already absolutized by the CLI; file
	// values are resolved vs. the config dir; default is the config dir (or
	// searchFrom if no config). All paths emerge absolute.
	const root = resolvePath(merged.root, {
		fromConfig: !!fileConfig.root && inline.root === undefined,
		configDir,
		fallback: configDir,
	});

	// Resolve output the same way; default is `<root>/dist`.
	const output = resolvePath(merged.output, {
		fromConfig: !!fileConfig.output && inline.output === undefined,
		configDir,
		fallback: path.join(root, 'dist'),
	});

	return {
		configPath,
		userConfig: merged,
		flueConfig: {
			target: merged.target,
			root,
			output,
			models: merged.models ?? {},
		},
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
