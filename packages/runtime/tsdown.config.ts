import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/adapter.ts',
		'src/routing.ts',
		'src/internal.ts',
		'src/cloudflare/index.ts',
		'src/node/index.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
	// `cloudflare:workers` is a virtual module that only resolves
	// inside workerd. We import `DurableObject` from it in
	// `src/cloudflare/registry-do.ts`; marking the specifier external
	// keeps the import in the emitted bundle so workerd can resolve it
	// at runtime (rather than having rolldown fail to find a package
	// on disk at build time).
	deps: { neverBundle: ['cloudflare:workers'] },
});
