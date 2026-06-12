import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: ['src/index.ts', 'src/github.ts', 'src/slack.ts'],
	format: ['esm'],
	dts: true,
	clean: true,
	deps: { neverBundle: ['@flue/runtime'] },
});
