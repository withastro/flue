import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: ['test/vite-cloudflare-build.test.ts'],
	},
});
