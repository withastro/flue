import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/daytona.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
});
