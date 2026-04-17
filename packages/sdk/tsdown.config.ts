import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/client.ts', 'src/sandbox.ts', 'src/cloudflare/index.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
});
