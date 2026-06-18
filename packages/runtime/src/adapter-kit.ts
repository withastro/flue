/**
 * Public target-authoring primitives for platform adapters.
 *
 * This subpath is for deployment targets that need to wire Flue's runtime
 * coordinator pieces without importing target-private internals.
 */

export { Bash, InMemoryFs } from 'just-bash';

export type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentDispatchReceipt,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	PersistenceAdapter,
	PersistenceStores,
	SubmissionAttemptRef,
	SubmissionClaimRef,
	SubmissionDurability,
} from './agent-execution-store.ts';

export type { FlueContextConfig, FlueContextInternal } from './client.ts';
export { createFlueContext } from './client.ts';
export { resolveModel } from './internal.ts';
export type {
	AgentSubmissionInput,
	AgentSubmissionInterruption,
	AgentSubmissionObserver,
	AgentSubmissionObserverRegistry,
	AgentSubmissionSession,
	AttachedAgentSubmissionAdmission,
	createAgentSubmissionSessionHandler,
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
	ProcessAgentSubmissionOptions,
	ProcessSubmissionOptions,
} from './runtime/agent-submissions.ts';
export {
	createAgentSubmissionObserverRegistry,
	createDirectAgentSubmissionInput,
	processSubmission,
	reconcileInterruptedSubmission,
	submissionSyntheticRequest,
} from './runtime/agent-submissions.ts';
export type { DispatchInput } from './runtime/dispatch-queue.ts';
export type {
	EventStreamMeta,
	EventStreamReadResult,
	EventStreamStore,
} from './runtime/event-stream-store.ts';
export {
	agentStreamPath,
	DEFAULT_READ_LIMIT,
	formatOffset,
	MAX_READ_LIMIT,
	parseOffset,
	SqliteEventStreamStore,
} from './runtime/event-stream-store.ts';
export type {
	FlueForwardRouter,
	FlueForwardRunIndex,
	FlueForwardTarget,
	FlueRuntime,
	FlueRuntimeTarget,
	HandleRunRouteOptions,
} from './runtime/flue-app.ts';
export {
	configureFlueRuntime,
	createDefaultFlueApp,
	handleRunRouteRequest,
} from './runtime/flue-app.ts';
export type {
	CreateContextFn,
	DirectAttachedOptions,
	FailRecoveredRunOptions,
	HandleAgentOptions,
	HandleWorkflowOptions,
	InvokeWorkflowAttachedOptions,
	StartWorkflowAdmissionFn,
	WorkflowAttachedInvocationResult,
	WorkflowHandler,
} from './runtime/handle-agent.ts';
export {
	assertAgentDispatchAdmissionInput,
	failRecoveredRun,
	handleAgentRequest,
	handleWorkflowRequest,
} from './runtime/handle-agent.ts';
export { handleStreamHead, handleStreamRead } from './runtime/handle-stream-routes.ts';
export { generateWorkflowRunId } from './runtime/ids.ts';
export { hasRegisteredProvider } from './runtime/providers.ts';
export type {
	CreateRunInput,
	EndRunInput,
	ListRunsOpts,
	ListRunsResponse,
	RunPointer,
	RunRecord,
	RunStatus,
	RunStore,
} from './runtime/run-store.ts';
export {
	DEFAULT_LIST_LIMIT,
	decodeRunCursor,
	encodeRunCursor,
	isStreamExcludedEvent,
	MAX_LIST_LIMIT,
} from './runtime/run-store.ts';

export { bashFactoryToSessionEnv } from './sandbox.ts';

export { deleteSessionTree } from './session.ts';
export { createSqlRunStore } from './sql-run-store.ts';
export type {
	CompactionEntry,
	MessageEntry,
	SessionData,
	SessionEntry,
	SessionStore,
	TaskSessionRef,
} from './types.ts';
