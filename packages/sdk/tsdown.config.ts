import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/client.ts',
		'src/sandbox.ts',
		'src/internal.ts',
		'src/cloudflare/index.ts',
		'src/node/index.ts',
		'src/config.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
	// `wrangler` is a heavy peer/optional dep that the dev server lazy-imports
	// at runtime. Keep it external so the SDK bundle stays small.
	external: ['wrangler'],
});
