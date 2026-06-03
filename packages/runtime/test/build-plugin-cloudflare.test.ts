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

	it('pre-arms SQL-backed dispatch admission and reconciles runnable rows through managed Fibers', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(entry).toContain(
			`async onStart(props) {
    if (typeof super.onStart === 'function') await super.onStart(props);
    await reconcileFlueAgentSubmissions(this, "assistant", { preserveSuccessor: true });
  }

  async __flueWakeAgentSubmissions(wake) {
    await reconcileFlueAgentSubmissions(this, "assistant", { preserveSuccessor: true, executingWake: wake });
  }`,
		);
		expect(entry).toContain("const FLUE_AGENT_SUBMISSION_WAKE_CALLBACK = '__flueWakeAgentSubmissions';");
		expect(entry).toContain("await armFlueAgentSubmissionAdmissionWakes(doInstance);\n    let submission;");
		expect(entry).toContain('submission = getAgentExecutionStore(doInstance).submissions.admitDispatch(input);');
		expect(entry).toContain('const runnable = submissions.listRunnableDispatches();');
		expect(entry).toContain('metadata: { input: submission.input, submissionSequence: submission.sequence },');
		expect(entry).toContain('submissions.hasQueuedDispatchForSession(doInstance.name, session)');
		expect(entry).toContain('async function waitForEarlierLegacyManagedDispatch');
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
