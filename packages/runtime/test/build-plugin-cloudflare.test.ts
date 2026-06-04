import { describe, expect, it } from 'vitest';
import { CloudflarePlugin } from '../../cli/src/lib/build-plugin-cloudflare.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('CloudflarePlugin', () => {
	it('generates distinct Flue-owned Durable Object identities for agents and workflows', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'draft-workflow', filePath: '/fixture/agents/draft-workflow.ts' }],
				workflows: [{ name: 'draft', filePath: '/fixture/workflows/draft.ts' }],
			}),
		);

		expect(entry).toContain('class FlueDraftWorkflowAgent');
		expect(entry).toContain('class FlueDraftWorkflow');
		expect(entry).toContain('bindingName: "FLUE_DRAFT_WORKFLOW_AGENT"');
		expect(entry).toContain('bindingName: "FLUE_DRAFT_WORKFLOW"');
	});

	it('initializes durable agent execution stores without changing workflow run-store behavior', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				workflows: [{ name: 'draft', filePath: '/fixture/workflows/draft.ts' }],
			}),
		);

		expect(entry).toContain('createSqlAgentExecutionStore');
		expect(entry).toContain('createSqlSessionStore');
		expect(entry).toContain(
			`constructor(ctx, env) {
    const executionStore = createSqlAgentExecutionStore(ctx.storage, "FlueAssistantAgent");
    super(ctx, env);
    this[FLUE_AGENT_EXECUTION_STORE] = executionStore;
  }`,
		);
		expect(entry).not.toContain('const agentExecutionStores = new WeakMap();');
		expect(entry).toContain('const memoryWorkflowSessionStore = new InMemorySessionStore();');
		expect(entry).toContain(
			'const defaultStore = sql ? createSqlSessionStore(sql) : memoryWorkflowSessionStore;',
		);
		expect(entry).toContain('createDurableRunStore(doInstance.ctx.storage.sql)');
		expect(entry).toContain(': memoryRunStore;');
		expect(entry).not.toContain('function createDOStore(sql)');
		expect(entry).not.toContain('const memoryStore = new InMemorySessionStore();');
		expect(entry).not.toContain('CREATE TABLE IF NOT EXISTS flue_sessions');
	});

	it('pre-arms SQL-backed dispatch admission and drains claimed rows without managed Fibers', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(entry).toContain(
			`async onStart(props) {
    await restoreFlueAgentSubmissionWake(this);
    if (typeof super.onStart === 'function') await super.onStart(props);
    await reconcileFlueAgentSubmissions(this, "assistant", { driverAlreadyArmed: true });
  }

  async __flueWakeAgentSubmissions() {
    const submissions = getAgentExecutionStore(this).submissions;
    if (!submissions.hasUnsettledSubmissions()) return;
    await armFlueAgentSubmissionWake(this, { idempotent: false });
    await reconcileFlueAgentSubmissions(this, "assistant", { driverAlreadyArmed: true });
  }`,
		);
		expect(entry).toContain("const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';");
		expect(entry).not.toContain('scheduleEvery');
		expect(entry).toContain("await armFlueAgentSubmissionAdmissionWake(doInstance);\n    let submission;");
		expect(entry).toContain('cleanupFlueAgentSubmissionTerminalState(doInstance);');
		expect(entry).toContain('submissions.cleanupDispatchReceipt(input.dispatchId, Date.now() - FLUE_AGENT_SUBMISSION_TERMINAL_RETENTION_MS);');
		expect(entry).toContain('const priorReceipt = submissions.getDispatchReceipt(input.dispatchId);');
		expect(entry).toContain('submission = submissions.admitDispatch(input);');
		expect(entry).toContain('if (error instanceof SqlAgentDispatchReceiptRetainedError) return Response.json({ dispatchId: error.receipt.submissionId, acceptedAt: new Date(error.receipt.acceptedAt).toISOString() });');
		expect(entry).toContain('for (const submission of submissions.listRunningSubmissions()) {');
		expect(entry).toContain('if (activeFlueAgentSubmissionAttempts.has(submissionAttemptLocalKey(doInstance, submission))) continue;');
		expect(entry).toContain("if (submission.status !== 'terminalizing' && attemptMarkers.keys.has(submissionAttemptMarkerKey(submission)) && submission.recoveryRequestedAt === undefined) continue;");
		expect(entry).toContain('await reconcileInterruptedSqlAgentSubmission(submission, doInstance, agentName);');
		expect(entry).toContain('await restoreFlueAgentSubmissionWake(doInstance);\n  const submissions = getAgentExecutionStore(doInstance).submissions;\n  submissions.requestSubmissionRecovery(submissionId, attemptId);');
		expect(entry).toContain("SELECT snapshot, created_at FROM cf_agents_runs WHERE name = 'flue:submission-attempt'");
		expect(entry).toContain('if (Date.now() - row.created_at > FLUE_AGENT_SUBMISSION_ATTEMPT_STALE_MS) continue;');
		expect(entry).toContain('submissions.requeueSubmissionBeforeInputApplied(submission.submissionId, attemptId);');
		expect(entry).toContain('createDispatchInputInspectionHandler(agent, input)(ctx)');
		expect(entry).toContain('createDirectSubmissionInputInspectionHandler(agent, input)(ctx)');
		expect(entry).toContain('if (!submissions.markSubmissionInputApplied(submission.submissionId, attemptId)) {');
		expect(entry).toContain('const claimed = submissions.claimSubmission(submission.submissionId, crypto.randomUUID());');
		expect(entry).toContain("running = doInstance.runFiber('flue:submission-attempt', async (fiberCtx) => {");
		expect(entry).toContain("fiberCtx.stash({ submissionId: submission.submissionId, attemptId: submission.attemptId });");
		expect(entry).toContain("activeFlueAgentSubmissionAttempts.delete(attemptKey);\n    throw error;");
		expect(entry).toContain('const completed = submissions.completeSubmission(submission.submissionId, attemptId);');
		expect(entry).toContain("if (completed && submission.kind === 'direct') agentSubmissionObservers.complete(submission.submissionId, result);");
		expect(entry).toContain("if (submission.kind === 'direct') ctx?.setEventCallback(undefined);");
		expect(entry).toContain('getAgentExecutionStore(doInstance).submissions.admitDirect(input);');
		expect(entry).toContain('admitAttachedSubmission: (payload, req, onEvent) => admitAttachedAgentSubmission(doInstance, agentName, payload, req, onEvent)');
		expect(entry).toContain('getAgentExecutionStore(doInstance).submissions.adoptLegacyDispatches(dispatches.map((dispatch) => dispatch.input));');
		expect(entry).toContain("idempotent: options.idempotent ?? true");
		expect(entry).toContain("idempotent: false");
		expect(entry).not.toContain('generation:');
		expect(entry).not.toContain('beginFlueAgentSubmissionAdmission');
		expect(entry).not.toContain('cancelSchedule(schedule.id)');
		expect(entry).toContain('getAgentExecutionStore(doInstance).submissions.cleanupTerminalSubmissions(\n    Date.now() - FLUE_AGENT_SUBMISSION_TERMINAL_RETENTION_MS,');
		expect(entry).toContain('begin: (sessionKey) => executionStore.submissions.beginSessionDeletion(sessionKey)');
		expect(entry).toContain('if (submission.status !== \'terminalizing\' && !submissions.beginSubmissionTerminalization(submission.submissionId, attemptId)) return;');
		expect(entry).toContain('createSubmissionTerminalHandler(agent, input, {');
		expect(entry).toContain('submissions.finalizeSubmissionTerminalization(submission.submissionId, attemptId, error)');
		expect(entry).toContain("if (failed && submission.kind === 'direct') agentSubmissionObservers.fail(submission.submissionId, error);");
		expect(entry).not.toContain('const { manifest, directHandlers, localAgentHandlers, createdAgents');
		expect(entry).not.toContain('assertNoPendingDispatchForDirectSession');
		expect(entry).not.toContain("runFiber('flue:direct'");
		expect(entry).not.toContain('listActiveDirectAgentSessionMarkers');
		expect(entry).not.toContain('agentSubmissionObservers.takeRequest');
		expect(entry).toContain("return handleFlueDispatchAttemptRecovered(ctx, this);");
		expect(entry).toContain("submissionId: 'legacy-direct:' + ctx.id");
		expect(entry).toContain('createLegacyDirectSubmissionTerminalHandler(agent, input, {');
		expect(entry).not.toContain("startFiber('flue:dispatch'");
		expect(entry).not.toContain('inspectFiberByKey');
		expect(entry).not.toContain('ctx.storage.setAlarm');
	});

	it('uses explicit Flue routing instead of the Agents SDK router', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(entry).toContain('class FlueAssistantAgent');
		expect(entry).toContain('bindingName: "FLUE_ASSISTANT_AGENT"');
		expect(entry).toContain("import { Agent, getAgentByName } from 'agents'");
		expect(entry).toContain('return fetchAgent(binding, target.instanceId, request)');
		expect(entry).toContain('(await getAgentByName(binding, instanceId)).fetch(request)');
		expect(entry).not.toContain("routeAgentRequest } from 'agents'");
	});
});

function testBuildContext(overrides: Partial<BuildContext> = {}): BuildContext {
	return {
		agents: [],
		workflows: [],
		root: '/fixture',
		output: '/fixture/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/fixture', sourceRoot: '/fixture', target: 'cloudflare' },
		...overrides,
	};
}
