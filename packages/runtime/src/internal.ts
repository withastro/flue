/**
 * Internal runtime helpers consumed by the generated server entry point.
 *
 * This subpath is NOT part of the public API. It exists so the build
 * plugins (Node, Cloudflare) can emit stable bare-specifier imports that
 * resolve through normal package-exports resolution at both build time and
 * runtime, for both workspace-linked and published-npm installs — plus a
 * small number of narrowly-scoped break-glass operator helpers.
 *
 * User agent code should never import from here.
 */
export type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionDurability,
	SubmissionSettlementObligation,
} from './agent-execution-store.ts';
export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { createFlueContext } from './client.ts';
export {
	CLOUDFLARE_AGENT_INTERNAL_DISPATCH_PATH,
	CLOUDFLARE_AGENT_INTERNAL_INSTANCE_INFO_PATH,
	createCloudflareAgentRuntime,
} from './cloudflare/agent-coordinator.ts';
export { createSqlConversationStores } from './cloudflare/agent-execution-store.ts';
// Overflow classifier, exposed for application regression tripwires that
// assert the 413→overflow chain against the installed runtime (#468). Not an
// authoring API: agent code never classifies its own failures.
export { isAssistantContextOverflow } from './compaction.ts';
// Conversation wire types projected onto the HTTP `history`/`updates` views.
// Exposed here only so the SDK can pin its public projection types to the
// runtime's emitted shapes via a compile-time assignability test.
export type { AgentConversationSnapshot, ConversationStreamChunk } from './conversation-public.ts';
export { configureErrorRendering, RuntimeUnavailableError, toHttpResponse } from './errors.ts';
export type { InstrumentationOwner } from './instrumentation.ts';
export { createInstrumentationOwner, runWithInstrumentationOwner } from './instrumentation.ts';
// Coordinator-facing MCP shapes: the per-instance connection resolvers the
// Node and Cloudflare coordinators inject into submission contexts.
export type { McpConnectionDefinition, McpConnectionResolver } from './mcp.ts';
export { createNodeAgentCoordinator, createNodeDispatchQueue } from './node/agent-coordinator.ts';
// The shared Node runtime assembly `start()` and the CLI's `flue run` build
// on: registration → persistence validation → coordinator → runtime seed.
export type {
	AssembledNodeAgentRuntime,
	AssembleNodeAgentRuntimeOptions,
} from './node/assemble.ts';
export { assembleNodeAgentRuntime, connectPersistenceAdapter } from './node/assemble.ts';
export type {
	AgentSubmissionInput,
	AttachedAgentSubmissionAdmission,
	AttachedAgentSubmissionOptions,
} from './runtime/agent-submissions.ts';
export type { AttachmentStore } from './runtime/attachment-store.ts';
export { InMemoryAttachmentStore } from './runtime/attachment-store.ts';
export { registerDefaultProviders } from './runtime/builtin-providers.ts';
// Submission-scoped conversation observation: in-process settlement waits and
// reply reads over the canonical stream (the CLI's `flue run` and the
// programmatic agent client build on these).
export type {
	ObserveSubmissionSettlementOptions,
	ReadSubmissionReplyOptions,
	SubmissionReply,
	SubmissionSettlement,
} from './runtime/conversation-observer.ts';
export {
	observeSubmissionSettlement,
	readSubmissionReply,
	replyFromSnapshot,
} from './runtime/conversation-observer.ts';
export type { ConversationStreamStore } from './runtime/conversation-stream-store.ts';
export {
	InMemoryConversationStreamStore,
	SqliteConversationStreamStore,
} from './runtime/conversation-stream-store.ts';
export type { AgentInteractionStart } from './runtime/dev-lifecycle-logger.ts';
export { installDevLifecycleLogger } from './runtime/dev-lifecycle-logger.ts';
export type { DispatchInput, DispatchQueue } from './runtime/dispatch-queue.ts';
export type { CloudflareRuntime, FlueRuntime, NodeRuntime } from './runtime/flue-app.ts';
// `configureFlueRuntime` seeds the module-scoped config that mounted
// agent-router handlers read at request time. Called once per generated entry,
// before the listener (Node) or `default.fetch` (Cloudflare) takes traffic.
export { configureFlueRuntime } from './runtime/flue-app.ts';
export type {
	CreateAgentContextFn,
	CreateAgentContextOptions,
	HandleAgentOptions,
} from './runtime/handle-agent.ts';
export {
	handleAgentConversationHead,
	handleAgentConversationRead,
} from './runtime/handle-conversation-routes.ts';
export {
	hasProvider,
	registerBuiltinProviderModule,
	resetModelsForTests,
	resolveModel,
	setProvider,
} from './runtime/providers.ts';
// Identity registry consumed by the generated bootstraps (the scanned
// `'use agent'` set), the CLI, and unit tests mounting createAgentRouter().
export type { FlueAgentRegistration } from './runtime/registration.ts';
export {
	AGENT_IDENTITY_PATTERN,
	getRegisteredFlueAgents,
	registerFlueAgents,
	resetFlueAgentRegistrationForTests,
	resolveAgentIdentity,
	resolveAgentInitialDataSchema,
} from './runtime/registration.ts';
export type { RuntimeActivityGate, RuntimeActivityLease } from './runtime/runtime-activity-gate.ts';
export { createRuntimeActivityGate } from './runtime/runtime-activity-gate.ts';
// Divergence repair for the settlement cache (ledger restored from backup):
// re-derives terminal rows from the streams' settle records.
export { rebuildSettledSubmissionRows } from './runtime/settlement-rebuild.ts';
// Storage path of an agent instance's canonical conversation stream — the
// durable-storage contract callers pair with the observation helpers above.
export { agentStreamPath } from './runtime/stream-offsets.ts';

export { bashFactoryToSessionEnv } from './sandbox.ts';
export { parseSkillMarkdown } from './skill-frontmatter.ts';
export { buildPackagedSkill, createSkillReference } from './skill-package.ts';
