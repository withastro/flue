import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: ['src/index.ts'],
		format: ['esm'],
		dts: true,
		clean: true,
		deps: { neverBundle: ['@flue/runtime', 'postgres'] },
	},
	run: {
		tasks: {
			build: {
				command: 'vp pack',
				output: ['dist/**'],
			},
			'check:types': 'tsc --noEmit',
			test: {
				command: 'vp test run',
				dependsOn: ['@flue/runtime#build'],
			},
		},
	},
});
