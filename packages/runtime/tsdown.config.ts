import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/app.ts',
		'src/client-compat.ts',
		'src/sandbox-compat.ts',
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
	external: ['cloudflare:workers'],
});
