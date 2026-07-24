import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: {
		// Bin entry, written to dist/flue.mjs (the build script renames to dist/flue.js).
		flue: 'src/main.ts',
		// `flue run` execution bootstrap. NOT imported by the bin bundle: it is
		// loaded through the run command's Vite module server so its
		// `@flue/runtime` imports resolve inside the user project's
		// single-runtime graph (see src/lib/run-local.ts).
		'run-bootstrap': 'src/lib/run-bootstrap.ts',
	},
	format: ['esm'],
	// No public subpaths remain — the CLI ships only the `flue` binary — so
	// declaration output is unnecessary.
	dts: false,
	clean: true,
	outDir: 'dist',
	deps: {
		neverBundle: [
			'vite',
			'@flue/runtime',
			'@flue/runtime/internal',
			'@flue/runtime/config',
			'@flue/runtime/node',
			'@flue/vite',
			'@flue/vite/internal',
		],
	},
});
