import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: ['src/index.ts'],
		format: ['esm'],
		dts: true,
		clean: true,
		deps: { neverBundle: ['@flue/runtime', '@opentelemetry/api'] },
	},
});
