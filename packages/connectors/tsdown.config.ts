import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/daytona.ts', 'src/vercel.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
});
