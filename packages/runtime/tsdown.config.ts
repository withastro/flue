import { defineConfig } from 'tsdown';

export default defineConfig({
	entry: [
		'src/index.ts',
		'src/adapter.ts',
		'src/routing.ts',
		'src/config.ts',
		'src/tool-entrypoint.ts',
		'src/internal.ts',
		'src/telemetry/index.ts',
		'src/cloudflare/index.ts',
		'src/cloudflare/internal.ts',
		'src/cloudflare/workers-ai-provider.ts',
		'src/node/index.ts',
		'src/test-utils/define-store-contract-tests.ts',
		'src/test-utils/define-attachment-store-contract-tests.ts',
		'src/test-utils/define-conversation-stream-store-contract-tests.ts',
	],
	format: ['esm'],
	dts: true,
	clean: true,
	// `cloudflare:workers` is a virtual module that only resolves
	// inside workerd. `src/cloudflare/extension.ts` type-imports it;
	// marking the specifier external keeps any import in the emitted
	// bundle so workerd can resolve it at runtime (rather than having
	// rolldown fail to find a package on disk at build time).
	deps: { neverBundle: ['cloudflare:workers', 'vitest'] },
});
