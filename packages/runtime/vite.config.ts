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
			'src/test-utils/define-event-stream-store-contract-tests.ts',
		],
		format: ['esm'],
		dts: true,
		clean: true,
		deps: { neverBundle: ['cloudflare:workers', 'vite-plus/test'] },
	},
	run: {
		tasks: {
			build: {
				command: 'vp pack',
				output: ['dist/**', 'types/**'],
			},
			'check:types': 'tsc --noEmit',
			test: {
				command: 'vp test run',
				dependsOn: ['build'],
			},
			'test:integration:cloudflare': {
				command:
					'vp test run --config vitest.integration.cloudflare.config.ts --no-file-parallelism',
				cache: false,
			},
			'test:watch': {
				command: 'vp test',
				cache: false,
			},
		},
	},
});
