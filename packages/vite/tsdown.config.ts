import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	deps: { neverBundle: ['vite', '@cloudflare/vite-plugin', '@flue/cli'] },
});
