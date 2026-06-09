import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: {
		exclude: ['test/**/*.integration.test.ts'],
		include: ['test/**/*.test.ts'],
	},
});
