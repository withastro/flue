/**
 * Backwards-compatibility stub for old `@flue/sdk/*` subpath imports.
 *
 * The package previously published at `@flue/sdk` was renamed to
 * `@flue/runtime` (build/config helpers moved to `@flue/cli`). The
 * `@flue/sdk` name is now used for a new client-side SDK that talks to
 * deployed Flue actions — only its root export (`@flue/sdk`) carries real
 * code.
 *
 * Every legacy subpath (`./app`, `./client`, `./sandbox`, `./internal`,
 * `./cloudflare`, `./node`, `./config`) is mapped to this file in
 * `package.json` so old consumers get a clear migration error on import
 * instead of "module not found".
 *
 * Strategy:
 *   1. Re-export the union of every named runtime export the old package
 *      shipped across all subpaths as `undefined` placeholders. This is
 *      needed because ESM resolves named-import bindings at link time
 *      (before the module body runs), so `import { foo } from
 *      '@flue/sdk/client'` would otherwise fail with a generic
 *      "no export named foo" error before our `throw` ever fires.
 *   2. Then `throw` at top level. ESM evaluates module bodies before any
 *      bindings are observed, so any consumer of any subpath gets the
 *      migration error the moment they import from it.
 *
 * Remove this file (and its subpath entries in `package.json`) once the
 * migration window is closed.
 */

// Step 1: declare every name that used to be exported across all subpaths,
// so that named imports resolve at ESM link time. The values are dummies —
// step 2 throws before any consumer can read them.
const __noop = undefined;
export {
	// ./client
	__noop as Type,
	__noop as connectMcpServer,
	__noop as createFlueContext,
	// ./sandbox
	__noop as bashFactoryToSessionEnv,
	__noop as createCwdSessionEnv,
	__noop as createFlueFs,
	__noop as createSandboxSessionEnv,
	// ./app
	__noop as configureProvider,
	__noop as flue,
	__noop as observe,
	__noop as registerApiProvider,
	__noop as registerProvider,
	// ./internal
	__noop as InMemoryRunStore,
	__noop as InMemorySessionStore,
	__noop as configureFlueRuntime,
	__noop as createDefaultFlueApp,
	__noop as createDurableRunStore,
	__noop as createRunSubscriberRegistry,
	__noop as handleAgentRequest,
	__noop as handleRunRouteRequest,
	__noop as hasRegisteredProvider,
	__noop as resolveModel,
	// ./node
	__noop as createLocalSessionEnv,
	// ./cloudflare
	__noop as cfSandboxToSessionEnv,
	__noop as getCloudflareAIBindingApiProvider,
	__noop as getCloudflareContext,
	__noop as getDefaultWorkspace,
	__noop as getShellSandbox,
	__noop as getVirtualSandbox,
	__noop as hydrateFromBucket,
	__noop as runWithCloudflareContext,
	__noop as store,
	// ./config
	__noop as defineConfig,
	__noop as resolveConfig,
	__noop as resolveConfigPath,
};

// Step 2: throw on module evaluation. Fires before any imported binding can
// be observed at runtime, but after link-time symbol resolution has already
// succeeded.
throw new Error(
	'[@flue/sdk] This legacy subpath is no longer supported because the old runtime package moved. ' +
		'Write runtime imports from "@flue/runtime" instead, for example `import type { ActionContext } from "@flue/runtime"`; ' +
		'write config imports as `import { defineConfig } from "@flue/cli/config"`.',
);
