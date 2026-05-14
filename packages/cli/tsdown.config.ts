import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: {
		// Bin entry, written to dist/flue.mjs (the build script renames to dist/flue.js).
		flue: 'bin/flue.ts',
		// `@flue/cli/config` subpath, written to dist/config.mjs.
		config: 'src/lib/config.ts',
	},
	format: ['esm'],
	// tsdown emits `.d.mts` for every entry. We only need one for the
	// public `./config` subpath; the bin entry's `flue.d.mts` is a
	// near-empty stub that no consumer reads.
	dts: true,
	clean: true,
	outDir: 'dist',
	// `wrangler` is an optional peer dep, lazy-imported by the dev server.
	// Keep it external so the CLI bundle stays small.
	external: ['wrangler'],
});
