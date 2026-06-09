import { defineConfig } from 'vite-plus';

export default defineConfig({
	pack: {
		entry: {
			flue: 'bin/flue.ts',
			config: 'src/lib/config.ts',
		},
		format: ['esm'],
		dts: true,
		clean: true,
		outDir: 'dist',
		deps: { neverBundle: ['wrangler', 'vite', '@cloudflare/vite-plugin'] },
	},
});
