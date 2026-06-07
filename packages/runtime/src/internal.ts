/**
 * Internal runtime helpers consumed by the generated server entry point.
 *
 * This subpath is NOT part of the public API. It exists solely so the build
 * plugins (Node, Cloudflare) can emit stable bare-specifier imports that
 * resolve through normal package-exports resolution at both build time and
 * runtime, for both workspace-linked and published-npm installs.
 *
 * User agent code should never import from here.
 */
import { type Api, getModel, type KnownProvider, type Model } from '@earendil-works/pi-ai';

export { Bash, InMemoryFs } from 'just-bash';

import { getProviderConfiguration, resolveRegisteredModel } from './runtime/providers.ts';
import type { ModelConfig, ProviderConfiguration } from './types.ts';

export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { createFlueContext } from './client.ts';
// `FlueRegistry` (Durable Object class) and `createCloudflareRunRegistry`
// (registry client) live in the `@flue/runtime/cloudflare` subpath because
// they pull in `cloudflare:workers`, a virtual module Node can't resolve.
// The generated CF entry imports them from there directly.
export { CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH, createCloudflareAgentRuntime } from './cloudflare/agent-coordinator.ts';
export { createSqlSessionStore } from './cloudflare/agent-execution-store.ts';
export { createDurableRunStore } from './cloudflare/run-store.ts';
export { createNodeAgentCoordinator, createNodeDispatchQueue } from './node/agent-coordinator.ts';
export { createNodeAgentExecutionStore } from './node/agent-execution-store.ts';
export { InMemoryRunRegistry } from './node/run-registry.ts';
export { InMemoryRunStore } from './node/run-store.ts';
export {
	DURABILITY_DEFAULT_MAX_RETRY,
	DURABILITY_DEFAULT_TIMEOUT_MINUTES,
} from './agent-execution-store.ts';
export type {
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionDurability,
} from './agent-execution-store.ts';
export {
	SUBMISSION_HARNESS_NAME,
	deduplicateSessionDeletion,
	isSubmissionPayload,
	parseAcceptedAt,
} from './adapter-helpers.ts';
export type { SubmissionPayloadContext } from './adapter-helpers.ts';
export type { DispatchInput, DispatchQueue } from './runtime/dispatch-queue.ts';
export type { ExposedTransport, FlueRuntime } from './runtime/flue-app.ts';
export {
	configureFlueRuntime,
	createDefaultFlueApp,
	dispatch,
	registeredAgentsForTransport,
	registeredWorkflowsForTransport,
	resetFlueRuntimeForTests,
} from './runtime/flue-app.ts';
export type {
	AgentHandler,
	CreateContextFn,
	CreatedAgentHandler,
	DirectAttachedOptions,
	FailRecoveredRunOptions,
	HandleAgentOptions,
	HandleWorkflowOptions,
	InvokeWorkflowAttachedOptions,
	RunHandlerFn,
	StartWorkflowAdmissionFn,
	WorkflowAttachedInvocationResult,
	WorkflowHandler,
} from './runtime/handle-agent.ts';
// Runtime modules consumed by the generated server entries.
//
//   - `configureFlueRuntime` seeds the module-scoped config that
//     `flue()` reads at request time. Called once per generated entry,
//     before the listener (Node) or `default.fetch` (Cloudflare) takes
//     traffic.
//
//   - `createDefaultFlueApp` is the no-`app.ts` fallback. Lives in
//     @flue/runtime so the generated entry doesn't have to import `hono` (which
//     keeps user projects from needing it as a direct dep when they
//     don't author their own `app.ts`).
//
// The user-facing `flue()` itself is re-exported from `@flue/runtime/routing`, not here.
export {
	createDirectAgentHandler,
	failRecoveredRun,
	handleWorkflowRequest,
	invokeDirectAttached,
	invokeWorkflowAttached,
} from './runtime/handle-agent.ts';
export type { HandleRunRouteOptions } from './runtime/handle-run-routes.ts';
export { handleRunRouteRequest } from './runtime/handle-run-routes.ts';
export { generateWorkflowRunId, parseWorkflowRunId } from './runtime/ids.ts';
export { hasRegisteredProvider, resetProvidersForTests } from './runtime/providers.ts';
export type {
	ListRunsOpts,
	ListRunsResponse,
	RecordRunEndInput,
	RecordRunStartInput,
	RunOwner,
	RunPointer,
	RunRegistry,
} from './runtime/run-registry.ts';
export type { RunRecord, RunStatus, RunStore } from './runtime/run-store.ts';
export type { RunSubscriberListener, RunSubscriberRegistry } from './runtime/run-subscribers.ts';
export { createRunSubscriberRegistry } from './runtime/run-subscribers.ts';
export {
	createWebSocketErrorMessage,
	parseAgentWebSocketMessage,
	parseWorkflowWebSocketMessage,
} from './runtime/websocket-protocol.ts';
export { closeFlueSocket, isFlueSocket, socketRequestUrl } from './cloudflare/websocket.ts';
export { bashFactoryToSessionEnv } from './sandbox.ts';
export { createDispatchAgentSubmissionInput } from './runtime/agent-submissions.ts';
export type { DirectAgentSubmissionInput, DispatchAgentSubmissionInput } from './runtime/agent-submissions.ts';
export { createSessionStorageKey } from './session-identity.ts';
export { InMemorySessionStore } from './session.ts';
export { parseSkillMarkdown } from './skill-frontmatter.ts';
export type { DispatchReceipt } from './types.ts';

/**
 * Resolve a `provider-id/model-id` model specifier to a pi-ai Model.
 * Registered provider IDs win over pi-ai's catalog; configured provider
 * settings patch the resolved Model.
 */
export function resolveModel(model: ModelConfig | undefined): Model<Api> | undefined {
	if (model === false || model === undefined) return undefined;

	const modelSpecifier = model;

	const slash = modelSpecifier.indexOf('/');
	if (slash === -1) {
		throw new Error(
			`[flue] Invalid model specifier "${modelSpecifier}". ` +
				`Use the "provider-id/model-id" format (e.g. "anthropic/claude-haiku-4-5").`,
		);
	}
	const providerId = modelSpecifier.slice(0, slash);
	const modelId = modelSpecifier.slice(slash + 1);

	const registered = resolveRegisteredModel(providerId, modelId);
	if (registered) {
		if (modelId === '') {
			throw new Error(
				`[flue] Invalid model specifier "${modelSpecifier}". ` +
					`Provider ID "${providerId}" is registered via registerProvider(), but no model ID ` +
					`was given. Use "${providerId}/<model-id>".`,
			);
		}
		return applyProviderSettings(registered, getProviderConfiguration(providerId));
	}

	// `getModel` is typed for literal model IDs; runtime strings are checked by
	// the null return below.
	const resolved = getModel(providerId as KnownProvider, modelId as never);
	if (!resolved) {
		throw new Error(
			`[flue] Unknown model specifier "${modelSpecifier}". ` +
				`Provider ID "${providerId}" / model ID "${modelId}" ` +
				`is not registered with @earendil-works/pi-ai or via registerProvider().`,
		);
	}
	return applyProviderSettings(resolved, getProviderConfiguration(providerId));
}

function applyProviderSettings<TApi extends Api>(
	model: Model<TApi>,
	providerSettings: ProviderConfiguration | undefined,
): Model<TApi> {
	if (!providerSettings) return model;

	const hasBaseUrl = providerSettings.baseUrl !== undefined;
	const hasHeaders = providerSettings.headers !== undefined;
	if (!hasBaseUrl && !hasHeaders) return model;

	return {
		...model,
		baseUrl: providerSettings.baseUrl ?? model.baseUrl,
		headers: hasHeaders ? { ...(model.headers ?? {}), ...providerSettings.headers } : model.headers,
	};
}
