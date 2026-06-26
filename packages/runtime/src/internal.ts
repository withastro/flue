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

import { resolveRegisteredModel } from './runtime/providers.ts';
import type { ModelConfig } from './types.ts';

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
	SubmissionSettlementObligation,
} from './agent-execution-store.ts';
export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { createFlueContext, initializeRootHarness } from './client.ts';
// `FlueRegistry` (Durable Object class) and the composite Cloudflare run
// store/index factories live in the `@flue/runtime/cloudflare/internal`
// subpath because that entry pulls in `cloudflare:workers`, a virtual module
// Node can't resolve. The generated CF entry imports them from there
// directly; nothing here may import `cloudflare:workers`.
export {
	CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
	createCloudflareAgentRuntime,
} from './cloudflare/agent-coordinator.ts';
export { createSqlConversationStores } from './cloudflare/agent-execution-store.ts';
export { RuntimeUnavailableError, toHttpResponse } from './errors.ts';
export type { InstrumentationOwner } from './instrumentation.ts';
export {
	createInstrumentationOwner,
	runWithInstrumentationOwner,
} from './instrumentation.ts';
export { createNodeAgentCoordinator, createNodeDispatchQueue } from './node/agent-coordinator.ts';
export { InMemoryRunStore } from './node/run-store.ts';
export type {
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
} from './runtime/agent-submissions.ts';
export type { AttachmentStore } from './runtime/attachment-store.ts';
export { InMemoryAttachmentStore } from './runtime/attachment-store.ts';
export type {
	ConversationSnapshotStore,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
export {
	InMemoryConversationStreamStore,
	SqliteConversationSnapshotStore,
	SqliteConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
export type { AgentInteractionStart } from './runtime/dev-lifecycle-logger.ts';
export { installDevLifecycleLogger } from './runtime/dev-lifecycle-logger.ts';
export type { DispatchInput, DispatchQueue } from './runtime/dispatch-queue.ts';
export type { EventStreamStore } from './runtime/event-stream-store.ts';
export { SqliteEventStreamStore } from './runtime/event-stream-store.ts';
export type {
	AgentRecord,
	CloudflareRuntime,
	FlueRuntime,
	HandleRunRouteOptions,
	NodeRuntime,
	WorkflowRecord,
} from './runtime/flue-app.ts';
export {
	configureFlueRuntime,
	createDefaultFlueApp,
	handleRunRouteRequest,
} from './runtime/flue-app.ts';
export type {
	AdmitDetachedWorkflowOptions,
	CreateAgentContextFn,
	CreateAgentContextOptions,
	CreateWorkflowContextFn,
	CreateWorkflowContextOptions,
	DirectAttachedOptions,
	FailRecoveredRunOptions,
	HandleAgentOptions,
	HandleWorkflowOptions,
	InvokeWorkflowAttachedOptions,
	StartWorkflowAdmissionFn,
	WorkflowAttachedInvocationResult,
	WorkflowSchedulingPhases,
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
	admitDetachedWorkflow,
	assertWorkflowDefinition,
	failRecoveredRun,
	handleWorkflowRequest,
	invokeDirectAttached,
	invokeWorkflowAttached,
} from './runtime/handle-agent.ts';
export {
	handleAgentConversationHead,
	handleAgentConversationRead,
} from './runtime/handle-conversation-routes.ts';
export { handleStreamHead, handleStreamRead } from './runtime/handle-stream-routes.ts';
export { generateWorkflowRunId } from './runtime/ids.ts';
export { hasRegisteredProvider, resetProviderRuntime } from './runtime/providers.ts';
export type {
	ListRunsOpts,
	ListRunsResponse,
	RunPointer,
	RunRecord,
	RunStatus,
	RunStore,
	WorkflowRunPointer,
} from './runtime/run-store.ts';
export type {
	RuntimeActivityGate,
	RuntimeActivityLease,
} from './runtime/runtime-activity-gate.ts';
export { createRuntimeActivityGate } from './runtime/runtime-activity-gate.ts';

export { bashFactoryToSessionEnv } from './sandbox.ts';
export { parseSkillMarkdown } from './skill-frontmatter.ts';
export { buildPackagedSkill, createSkillReference } from './skill-package.ts';
export { createSqlRunStore } from './sql-run-store.ts';

/**
 * Resolve a `provider-id/model-id` model specifier to a pi-ai Model.
 * Registered provider IDs win over pi-ai's catalog; registrations for
 * catalog provider IDs hydrate metadata from the catalog with the
 * registration's options layered on top.
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
		return registered;
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
	return resolved;
}
