import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: ['src/index.ts'],
		format: ['esm'],
		dts: true,
		clean: true,
	},
	run: {
		tasks: {
			build: {
				command: 'vp pack',
				output: ['dist/**'],
			},
			'check:types': 'tsc --noEmit',
			test: 'vp test run',
		},
	},
});
