import {
	type AgentExecutionStore,
	type AgentSubmission,
	type AgentSubmissionObserver,
	type AgentSubmissionObserverRegistry,
	type AgentSubmissionStore,
	agentStreamPath,
	assertAgentDispatchAdmissionInput,
	Bash,
	bashFactoryToSessionEnv,
	type CreateRunInput,
	configureFlueRuntime,
	type createAgentSubmissionSessionHandler,
	createDefaultFlueApp,
	createDirectAgentSubmissionInput,
	createFlueContext,
	createSqlRunStore,
	type DirectAgentSubmissionInput,
	type EventStreamReadResult,
	type EventStreamStore,
	type FlueForwardRouter,
	type FlueForwardRunIndex,
	failRecoveredRun,
	generateWorkflowRunId,
	handleAgentRequest,
	handleRunRouteRequest,
	handleStreamHead,
	handleStreamRead,
	handleWorkflowRequest,
	hasRegisteredProvider,
	InMemoryFs,
	isStreamExcludedEvent,
	processSubmission,
	type RunStore,
	reconcileInterruptedSubmission,
	resolveModel,
	type SessionEntry,
	type SessionStore,
	SqliteEventStreamStore,
	type SubmissionDurability,
	submissionSyntheticRequest,
} from '@flue/runtime/adapter-kit';
import { describe, expect, it } from 'vitest';

describe('adapter-kit type surface', () => {
	it('type-checks target-authoring imports from one public subpath', () => {
		const values = [
			Bash,
			InMemoryFs,
			SqliteEventStreamStore,
			agentStreamPath,
			assertAgentDispatchAdmissionInput,
			bashFactoryToSessionEnv,
			configureFlueRuntime,
			createDefaultFlueApp,
			createDirectAgentSubmissionInput,
			createFlueContext,
			createSqlRunStore,
			failRecoveredRun,
			generateWorkflowRunId,
			handleAgentRequest,
			handleRunRouteRequest,
			handleStreamHead,
			handleStreamRead,
			handleWorkflowRequest,
			hasRegisteredProvider,
			isStreamExcludedEvent,
			processSubmission,
			reconcileInterruptedSubmission,
			resolveModel,
			submissionSyntheticRequest,
		];
		type Surface = {
			executionStore: AgentExecutionStore;
			submission: AgentSubmission;
			submissionObserver: AgentSubmissionObserver;
			submissionObservers: AgentSubmissionObserverRegistry;
			submissionStore: AgentSubmissionStore;
			createRun: CreateRunInput;
			directInput: DirectAgentSubmissionInput;
			readResult: EventStreamReadResult;
			eventStreamStore: EventStreamStore;
			router: FlueForwardRouter;
			runIndex: FlueForwardRunIndex;
			runStore: RunStore;
			session: SessionEntry;
			sessionStore: SessionStore;
			durability: SubmissionDurability;
			sessionHandlerFactory: typeof createAgentSubmissionSessionHandler;
		};
		const _typeOnly: Surface | undefined = undefined;

		expect(values.length).toBeGreaterThan(20);
		expect(_typeOnly).toBeUndefined();
	});
});
