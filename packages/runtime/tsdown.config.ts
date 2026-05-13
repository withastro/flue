import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/app.ts',
		'src/client-compat.ts',
		'src/sandbox-compat.ts',
		'src/internal.ts',
		'src/cloudflare/index.ts',
		'src/node/index.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
});
