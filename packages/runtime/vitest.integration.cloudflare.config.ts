import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'test/cloudflare-extension.integration.test.ts',
			'test/cloudflare-deployment-extension.integration.test.ts',
		],
	},
});
