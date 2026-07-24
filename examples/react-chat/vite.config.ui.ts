// The React UI build — a plain Vite SPA config, separate from the Flue
// server config (vite.config.ts). `pnpm run build:ui` emits static assets
// into dist/client, which the server's app.ts serves with serveStatic.
import { defineConfig } from 'vite';

export default defineConfig({
	root: 'src/ui',
	build: {
		outDir: '../../dist/client',
		emptyOutDir: true,
	},
});
