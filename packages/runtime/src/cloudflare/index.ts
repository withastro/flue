/**
 * Public authoring surface of `@flue/runtime/cloudflare`: APIs that user
 * agent modules import on the Cloudflare target.
 *
 * Generated-entry plumbing lives in `./internal.ts`
 * (`@flue/runtime/cloudflare/internal`). This entry only ever evaluates
 * inside workerd, so static `cloudflare:workers` imports are allowed on it
 * (today: `./tracing`'s namespace import) — but keep that virtual module out
 * of the coordinator / root-internal graph, which the Node bootstrap
 * evaluates. The one in-repo Node evaluation of this barrel,
 * `test/package-entrypoints.test.ts`, mocks the specifier.
 */
// The Workers-AI binding failure surface: applications match/strip the 413
// overflow marker in telemetry and construct the error in regression tests
// against the installed runtime, so both need a public home (#468). They are
// Cloudflare-binding-specific and stay off the root barrel. The retryable
// marker's contract is provider-agnostic, but its only writer today is the
// Workers-AI stream truncation throw, so it lives here beside its sibling.
export {
	CloudflareAIBindingError,
	RETRYABLE_INTERRUPTION_MARKER,
	WORKERS_AI_OVERFLOW_MARKER,
} from '../errors.ts';
export type { CloudflareSandboxOptions, CloudflareSandboxStub } from './cf-sandbox.ts';
export { cloudflareSandbox } from './cf-sandbox.ts';
export type { CloudflareContext, FlueDurableObjectIdentity } from './context.ts';
export { getCloudflareContext, getDurableObjectIdentity } from './context.ts';
export type {
	CloudflareAgentLike,
	CloudflareExtension,
	ExtensionClass,
	GeneratedDurableObjectClass,
} from './extension.ts';
export { extend } from './extension.ts';
export type { CloudflareGatewayOptions } from './gateway.ts';
export { type CloudflareTracingOptions, createCloudflareTracing } from './tracing/index.ts';
// The Workers AI binding provider lives on its own subpath
// (@flue/runtime/cloudflare/workers-ai): importing it is what puts the
// binding dispatch code in a build, so it must not ride along with this
// barrel.
