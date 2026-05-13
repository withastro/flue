import { defineConfig } from 'vitest/config';

/**
 * Vitest config for `@flue/runtime`. Intentionally minimal — defaults
 * cover everything we need today (TS transformation via esbuild,
 * `*.test.ts` discovery, parallel runs).
 *
 * Tests live in `test/` colocated with the package they cover. Source
 * imports work directly (vitest handles TS through esbuild, so the
 * Node strip-only loader's parameter-property limitation we hit
 * during inline-script days does not apply).
 */
export default defineConfig({
	test: {
		// Keep the default include glob (`**/*.{test,spec}.?(c|m)[jt]s?(x)`).
		// Our tests are under `test/` and named `*.test.ts`; both match.
		include: ['test/**/*.test.ts'],
	},
});
