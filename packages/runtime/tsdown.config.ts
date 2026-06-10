import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/adapter.ts',
		'src/routing.ts',
		'src/internal.ts',
		'src/cloudflare/index.ts',
		'src/channel/chat-sdk.ts',
		'src/channel/chat-sdk/cloudflare.ts',
		'src/node/index.ts',
		'src/test-utils/define-store-contract-tests.ts',
		'src/test-utils/define-event-stream-store-contract-tests.ts',
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
	deps: { neverBundle: ['agents', 'agents/chat-sdk', 'chat', 'cloudflare:workers', 'vitest'] },
});
