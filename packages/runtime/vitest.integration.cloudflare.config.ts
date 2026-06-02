import { defineConfig } from 'vitest/config';

export default defineConfig({
	test: {
		include: [
			'test/cloudflare-agent-extension.integration.test.ts',
			'test-legacy/vite-cloudflare-build.test.ts',
		],
	},
});
