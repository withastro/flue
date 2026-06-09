import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: {
			flue: 'bin/flue.ts',
			config: 'src/lib/config.ts',
		},
		format: ['esm'],
		dts: true,
		clean: true,
		outDir: 'dist',
		deps: { neverBundle: ['wrangler', 'vite', '@cloudflare/vite-plugin'] },
	},
	run: {
		tasks: {
			build: {
				command: [
					'tsx scripts/generate-connector-index.ts',
					'vp pack',
					'mv dist/flue.mjs dist/flue.js',
				],
				output: ['dist/**', 'bin/_connectors.generated.ts'],
			},
			'check:types': {
				command: 'tsc --noEmit',
				dependsOn: ['@flue/runtime#build'],
			},
			test: {
				command: 'node --test',
				dependsOn: ['build'],
			},
		},
	},
});
