import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/app.ts',
		'src/internal.ts',
		'src/cloudflare/index.ts',
		'src/node/index.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
});
