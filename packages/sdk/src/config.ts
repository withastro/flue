/**
 * Project-level config loader for `flue.config.ts`.
 *
 * The file is searched in the source root — the same directory that holds
 * `agents/` and `roles/` (either `<workspaceDir>/.flue/` for the embedded
 * layout or `<workspaceDir>/` for the bare layout, resolved by
 * `resolveSourceRoot`). Searched extensions, in order:
 *
 *   1. flue.config.ts
 *   2. flue.config.mts
 *   3. flue.config.js
 *   4. flue.config.mjs
 *
 * `.ts` is canonical. We don't rely on Node's experimental TS strip-types
 * (which requires Node 22.6+ with `--experimental-strip-types` or Node 23+),
 * because Flue users may run any Node 22+ release. Instead, `.ts`/`.mts`
 * files are transformed with esbuild — the same dependency Flue already
 * uses for the build pipeline — written next to the original as a hidden,
 * uniquely-named `.mjs` sibling, imported via `pathToFileURL`, and
 * unlinked. The temp-file detour preserves Node's normal module resolution
 * (bare specifiers resolve against the user's `node_modules`; relative
 * specifiers resolve against the config file's directory) — both of which
 * would break under `data:` URL evaluation. `.js`/`.mjs` files take the
 * fast path and are imported directly.
 *
 * Loading is best-effort: if no file is found, `loadFlueConfig` returns
 * `null`. Callers treat that as "all defaults".
 */
import * as esbuild from 'esbuild';
import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

import { CLOUDFLARE_MODEL_PREFIX } from './cloudflare-model.ts';
import type { FlueConfig, ResolvedFlueConfig } from './types.ts';

/**
 * Prefixes Flue ships internally. User-defined entries with the same key
 * shadow these (intentional — gives users an escape hatch on the rare day
 * they need to override Flue's routing) but we emit a warning so the
 * shadowing is never silent.
 */
const BUILTIN_MODEL_PREFIXES: readonly string[] = [CLOUDFLARE_MODEL_PREFIX] as const;

const CONFIG_FILE_BASENAME = 'flue.config';
const CONFIG_FILE_EXTENSIONS = ['.ts', '.mts', '.js', '.mjs'] as const;

/**
 * Marker function — the public alias users import as `defineConfig`. Returns
 * its argument verbatim so the config file's exported value is a plain
 * `FlueConfig`. Exists purely for type inference and editor tooling.
 */
export function defineConfig(config: FlueConfig): FlueConfig {
	return config;
}

/**
 * Locate the flue.config file inside `sourceRoot`. Pass the directory that
 * holds `agents/` and `roles/`, not the project root — those differ on the
 * embedded `.flue/` layout. Returns the absolute path of the first match,
 * or `null` when no config exists.
 */
export function findFlueConfigPath(sourceRoot: string): string | null {
	for (const ext of CONFIG_FILE_EXTENSIONS) {
		const candidate = path.join(sourceRoot, `${CONFIG_FILE_BASENAME}${ext}`);
		if (fs.existsSync(candidate)) return candidate;
	}
	return null;
}

/**
 * Per-process cache of resolved configs, keyed by absolute source-root path.
 * `flue dev` calls `loadFlueConfig` twice on first build (once to resolve
 * the target, once during the actual build) — the cache makes the second
 * call free, both for I/O and for re-invoking `setup()`-side-effecty
 * factories on subsequent rebuilds. Bypassed by tests via
 * `__resetConfigCacheForTests`.
 */
const configCache = new Map<string, Promise<ResolvedFlueConfig | null>>();

/** Test-only hook to drop the cache between cases. Not part of the public API. */
export function __resetConfigCacheForTests(): void {
	configCache.clear();
}

/**
 * Load and validate `flue.config.{ts,mts,js,mjs}` from `sourceRoot`. Pass
 * the directory that holds `agents/` and `roles/` (use `resolveSourceRoot`
 * to derive it from a workspace dir). Returns `null` when no config file
 * exists. Throws on import failure or shape errors so misconfiguration
 * surfaces immediately at boot.
 *
 * Results are memoised per absolute path within a single process. That is
 * intentionally a soft cache: long-running watch-mode tools that mutate
 * `flue.config.ts` should call `__resetConfigCacheForTests` (or spawn a
 * fresh process) to see updates. Today, the only watch-mode caller
 * (`flue dev`) does its own full re-invocation of the build pipeline, and
 * the watcher does not yet observe `flue.config.ts` for changes — that's
 * a follow-up.
 */
export async function loadFlueConfig(
	sourceRoot: string,
): Promise<ResolvedFlueConfig | null> {
	const cacheKey = path.resolve(sourceRoot);
	const cached = configCache.get(cacheKey);
	if (cached) return cached;

	const promise = loadFlueConfigUncached(cacheKey);
	configCache.set(cacheKey, promise);
	// On rejection, drop the cache entry so the next call retries instead
	// of spreading the original failure across every dependent code path.
	promise.catch(() => configCache.delete(cacheKey));
	return promise;
}

async function loadFlueConfigUncached(
	sourceRoot: string,
): Promise<ResolvedFlueConfig | null> {
	const configPath = findFlueConfigPath(sourceRoot);
	if (!configPath) return null;

	const ext = path.extname(configPath);
	let mod: unknown;
	try {
		if (ext === '.ts' || ext === '.mts') {
			mod = await importTypeScriptConfig(configPath);
		} else {
			mod = await import(pathToFileURL(configPath).href);
		}
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(
			`[flue] Failed to load ${path.relative(process.cwd(), configPath)}: ${message}`,
		);
	}

	const exported = (mod as { default?: unknown }).default;
	if (exported === undefined) {
		throw new Error(
			`[flue] ${path.relative(process.cwd(), configPath)} has no default export. ` +
				`Use \`export default defineConfig({ ... })\`.`,
		);
	}

	return validateAndResolve(exported, configPath);
}

/**
 * Transform a `.ts`/`.mts` config to ESM with esbuild and evaluate it.
 *
 * The transformed source is written next to the original config as a
 * dotted-prefix sibling (e.g. `flue.config.ts` →
 * `.flue.config.<pid>.<rand>.mjs`) and imported via `pathToFileURL`. This
 * preserves Node's normal module resolution: bare specifiers like
 * `@flue/sdk` resolve against the user's `node_modules`, and relative
 * imports like `./helpers.ts` resolve relative to the config file's
 * directory — both of which would break with `data:` URL evaluation.
 *
 * The temporary file is unlinked on success and on failure. The dotted
 * prefix and the `.mjs` extension keep it from being picked up by the
 * agent/role discovery walks (which look for `agents/*.{ts,js,mts,mjs}`
 * and ignore dot-files at the workspace root).
 */
async function importTypeScriptConfig(configPath: string): Promise<unknown> {
	const source = await fs.promises.readFile(configPath, 'utf-8');
	const transformed = await esbuild.transform(source, {
		loader: 'ts',
		format: 'esm',
		target: 'node22',
		sourcefile: configPath,
	});

	const dir = path.dirname(configPath);
	const base = path.basename(configPath, path.extname(configPath));
	// `randomUUID` (CSPRNG) avoids the path being predictable to a hostile
	// co-tenant on a shared workspace filesystem. The pid prefix keeps the
	// tmp file easy to attribute when something is left behind after a kill.
	const unique = `${process.pid}.${randomUUID().replace(/-/g, '').slice(0, 12)}`;
	const tmpPath = path.join(dir, `.${base}.${unique}.mjs`);

	try {
		await fs.promises.writeFile(tmpPath, transformed.code, 'utf-8');
		// Cache-bust the URL so repeated dev-server reloads see the latest
		// content — Node's ESM loader keys on the resolved URL.
		const url = `${pathToFileURL(tmpPath).href}?t=${Date.now()}`;
		return await import(url);
	} finally {
		await fs.promises.unlink(tmpPath).catch(() => {
			/* best-effort cleanup */
		});
	}
}

function validateAndResolve(value: unknown, configPath: string): ResolvedFlueConfig {
	const rel = path.relative(process.cwd(), configPath);

	if (typeof value !== 'object' || value === null) {
		throw new Error(
			`[flue] ${rel} default export must be an object. ` +
				`Got ${value === null ? 'null' : typeof value}.`,
		);
	}

	const config = value as FlueConfig;
	validateTarget(config.target, rel);
	validateSetup(config.setup, rel);
	const models = validateModels(config.models, rel);

	return {
		target: config.target,
		setup: config.setup,
		models,
	};
}

function validateTarget(target: unknown, rel: string): void {
	if (target !== undefined && target !== 'node' && target !== 'cloudflare') {
		throw new Error(
			`[flue] Invalid \`target\` in ${rel}: ${JSON.stringify(target)}. ` +
				`Expected "node" or "cloudflare".`,
		);
	}
}

function validateSetup(setup: unknown, rel: string): void {
	if (setup !== undefined && typeof setup !== 'function') {
		throw new Error(`[flue] Invalid \`setup\` in ${rel}: must be a function or omitted.`);
	}
}

function validateModels(
	models: unknown,
	rel: string,
): Record<string, (suffix: string) => any> {
	const result: Record<string, (suffix: string) => any> = {};
	if (models === undefined) return result;

	if (typeof models !== 'object' || models === null) {
		throw new Error(
			`[flue] Invalid \`models\` in ${rel}: must be an object mapping ` +
				`prefix strings to factory functions.`,
		);
	}
	for (const [prefix, factory] of Object.entries(models)) {
		if (!prefix.endsWith('/')) {
			throw new Error(
				`[flue] Invalid \`models\` prefix ${JSON.stringify(prefix)} in ${rel}: ` +
					`must end with "/" (e.g. "ollama/").`,
			);
		}
		if (typeof factory !== 'function') {
			throw new Error(
				`[flue] Invalid \`models[${JSON.stringify(prefix)}]\` in ${rel}: ` +
					`must be a factory function (suffix) => Model.`,
			);
		}
		if (BUILTIN_MODEL_PREFIXES.includes(prefix)) {
			emitBuiltinShadowWarning(prefix, rel);
		}
		result[prefix] = factory as (suffix: string) => any;
	}
	return result;
}

/**
 * Loud-but-not-fatal: a user prefix collides with a Flue built-in. The
 * user's factory wins (per Fred's resolution-order policy) so this is
 * intended behaviour, but we warn once at load so the shadowing surfaces
 * in CI logs and isn't a silent surprise.
 *
 * Routed through a function rather than a bare console.warn so tests can
 * stub `setBuiltinShadowWarner` without touching the global console.
 */
let builtinShadowWarner: (message: string) => void = (message) => {
	console.warn(message);
};

export function setBuiltinShadowWarner(fn: (message: string) => void): void {
	builtinShadowWarner = fn;
}

function emitBuiltinShadowWarning(prefix: string, rel: string): void {
	builtinShadowWarner(
		`[flue] Warning: \`models[${JSON.stringify(prefix)}]\` in ${rel} shadows ` +
			`Flue's built-in "${prefix}" routing. Your factory will run instead. ` +
			`If unintentional, rename the prefix.`,
	);
}
