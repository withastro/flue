import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: {
		index: 'src/index.ts',
		// `@flue/vite/internal` — plumbing shared with `@flue/cli` (flue run).
		internal: 'src/internal.ts',
		'bootstrap/node-server': 'src/bootstrap/node-server.ts',
		'bootstrap/node-entry': 'src/bootstrap/node-entry.ts',
	},
	format: ['esm'],
	dts: true,
	clean: true,
	deps: {
		// The virtual:flue/* specifiers only resolve inside a Vite build/dev
		// graph that runs the flue() plugin, so they must survive the package
		// build verbatim.
		neverBundle: [
			/^virtual:flue\//,
			'vite',
			'tinyglobby',
			'magic-string',
			'@flue/runtime',
			'@hono/node-server',
		],
	},
});
