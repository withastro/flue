export type {
	CloudflareAgentClass,
	CloudflareAgentExtension,
	ResolvedCloudflareAgentExtension,
} from './agent-extension.ts';
export { extend, resolveCloudflareAgentExtension } from './agent-extension.ts';
export type { VirtualSandboxOptions } from './virtual-sandbox.ts';
export { getVirtualSandbox } from './virtual-sandbox.ts';

const CLOUDFLARE_SHELL_CONNECTOR_MIGRATION =
	'Run `flue add @cloudflare/shell`, then import Cloudflare Shell helpers from your generated `connectors/cloudflare-shell` file.';

export function getShellSandbox(..._args: unknown[]): never {
	throw new Error(
		`[flue] getShellSandbox() is no longer implemented by @flue/runtime/cloudflare because Cloudflare Shell sandboxes are project-owned. ${CLOUDFLARE_SHELL_CONNECTOR_MIGRATION}`,
	);
}

export function getDefaultWorkspace(..._args: unknown[]): never {
	throw new Error(
		`[flue] getDefaultWorkspace() is no longer implemented by @flue/runtime/cloudflare because Cloudflare Shell sandboxes are project-owned. ${CLOUDFLARE_SHELL_CONNECTOR_MIGRATION}`,
	);
}

export function hydrateFromBucket(..._args: unknown[]): never {
	throw new Error(
		`[flue] hydrateFromBucket() is no longer implemented by @flue/runtime/cloudflare because hydration belongs to the Cloudflare Shell connector. ${CLOUDFLARE_SHELL_CONNECTOR_MIGRATION}`,
	);
}

export type { CloudflareAIBinding, CloudflareAIBindingRegistration } from '../runtime/providers.ts';
export { cfSandboxToSessionEnv } from './cf-sandbox.ts';
export type { CloudflareContext, FlueDurableObjectIdentity } from './context.ts';
export {
	getCloudflareContext,
	getDurableObjectIdentity,
	runWithCloudflareContext,
} from './context.ts';
export type { CloudflareGatewayOptions } from './gateway.ts';
export { FlueRegistry } from './registry-do.ts';
export { createCloudflareRunRegistry } from './run-registry.ts';
export { store } from './session-store.ts';
export type {
	CloudflareAgentWebSocketOptions,
	CloudflareWebSocketAttachment,
	CloudflareWebSocketConnection,
	CloudflareWorkflowWebSocketOptions,
} from './websocket.ts';

export {
	connectCloudflareAgentWebSocket,
	connectCloudflareWorkflowWebSocket,
	messageCloudflareAgentWebSocket,
	messageCloudflareWorkflowWebSocket,
} from './websocket.ts';
export { getCloudflareAIBindingApiProvider } from './workers-ai-provider.ts';
