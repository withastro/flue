import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: [
			'src/index.ts',
			'src/adapter.ts',
			'src/routing.ts',
			'src/internal.ts',
			'src/cloudflare/index.ts',
			'src/node/index.ts',
			'src/test-utils/define-store-contract-tests.ts',
		],
		format: ['esm'],
		dts: true,
		clean: true,
		deps: { neverBundle: ['cloudflare:workers', 'vite-plus/test'] },
	},
});
