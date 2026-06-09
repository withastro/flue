import { defineConfig } from 'vite-plus';

export default defineConfig({
	run: {
		tasks: {
			'test:e2e': {
				command: 'node ./test/e2e.mjs',
				cache: false,
			},
		},
	},
});
