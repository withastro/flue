/**
 * `.env` loading for the Node dev server.
 *
 * `vite dev` runs user agent code in this process, and model providers
 * resolve API keys from `process.env` — so without this, developers had to
 * export their `.env` into the shell before starting the dev server (while
 * `flue run` loaded it for them). Vite's `loadEnv` reads the standard file
 * set (`.env`, `.env.local`, `.env.[mode]`, `.env.[mode].local`); values are
 * applied with shell-wins semantics, matching `flue run`.
 *
 * Injections are tracked in a process-global registry so a dev-server
 * restart (which re-runs this with fresh plugin instances) can tell "we set
 * this from a file" apart from "the shell had this": previously injected
 * values are reverted first, so an edited `.env` value applies after the
 * restart instead of losing to its own stale injection.
 *
 * Deployed servers (`dist/server.mjs`) read only the real environment, and
 * the Cloudflare target's `.dev.vars`/`.env` handling belongs to the sibling
 * plugin — this is dev-time, Node-target behavior only.
 */
import { loadEnv } from 'vite';

const INJECTED_ENV_REGISTRY = Symbol.for('flue.vite.injectedDevEnv');

type GlobalWithRegistry = typeof globalThis & {
	[INJECTED_ENV_REGISTRY]?: Map<string, string>;
};

/**
 * Load the project's `.env` file set into `process.env` (shell values win).
 * Returns the names of the injected variables, for logging.
 */
export function applyDevEnv(options: { mode: string; envDir: string | false }): string[] {
	revertPreviousInjection();
	const injected = new Map<string, string>();
	if (options.envDir !== false) {
		// The empty prefix loads every variable, not just VITE_-prefixed ones —
		// agent code is server-side, so there is no client-exposure concern.
		const fileEnv = loadEnv(options.mode, options.envDir, '');
		for (const [key, value] of Object.entries(fileEnv)) {
			if (process.env[key] !== undefined) continue;
			process.env[key] = value;
			injected.set(key, value);
		}
	}
	(globalThis as GlobalWithRegistry)[INJECTED_ENV_REGISTRY] = injected;
	return [...injected.keys()];
}

function revertPreviousInjection(): void {
	const registry = (globalThis as GlobalWithRegistry)[INJECTED_ENV_REGISTRY];
	if (!registry) return;
	for (const [key, value] of registry) {
		// Only revert what still holds the injected value; anything else was
		// changed out from under us and is no longer ours to manage.
		if (process.env[key] === value) delete process.env[key];
	}
	registry.clear();
}
