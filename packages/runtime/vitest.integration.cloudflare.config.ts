import { defineConfig } from 'vite-plus';

export default defineConfig({
	test: {
		include: ['test/cloudflare-deployment-extension.integration.test.ts'],
	},
});
