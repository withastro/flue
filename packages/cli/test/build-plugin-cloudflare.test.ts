import { describe, expect, it } from 'vitest';
import { CloudflarePlugin } from '../src/lib/build-plugin-cloudflare.ts';
import type { BuildContext } from '../src/lib/types.ts';

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
		expect(entry).toContain(
			'resolveCloudflareExtension(agentModules["draft-workflow"]',
		);
		expect(entry).toContain(
			'resolveCloudflareExtension(workflowModules["draft"]',
		);
		expect(entry).not.toContain('runtimeAgents');
		expect(entry).not.toContain('runtimeWorkflows');
	});

	it('delegates durable agent execution to the Cloudflare runtime with SQL-backed stores', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				workflows: [{ name: 'draft', filePath: '/fixture/workflows/draft.ts' }],
			}),
		);

		expect(entry).toContain('createCloudflareAgentRuntime');
		expect(entry).toContain('createSqlSessionStore');
		expect(entry).toContain('createSqlRunStore');
		expect(entry).toContain('createContext: createAgentContextForRequest');
		expect(entry).toContain(
			'function createAgentContextForRequest({ executionStore, instance, request, initialEventIndex, dispatchId })',
		);
	});

	it('passes normalized Workflow route and runs middleware to the outer Worker runtime', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				workflows: [{ name: 'report', filePath: '/fixture/workflows/report.ts' }],
			}),
		);

		expect(entry).toContain("if (typeof mod.route === 'function') workflow.route = mod.route;");
		expect(entry).toContain("if (typeof mod.runs === 'function') workflow.runs = mod.runs;");
		expect(entry).toContain('configureFlueRuntime({');
		expect(entry).toContain('workflows,');
		expect(entry).toContain('routeRunRequest: async (request, reqEnv, target) => {');
		expect(entry).toContain('return fetchAgent(binding, target.runId, request);');
		expect(entry).not.toContain('routeRunRequest: async (request, reqEnv, target) => runAttachedMiddleware');
	});

	it('wires ambient workflow invocation through a private per-run Durable Object request', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				workflows: [{ name: 'report', filePath: '/fixture/workflows/report.ts' }],
			}),
		);

		expect(entry).toContain(
			'const { agents, workflows, channelHandlers } = normalizeBuiltModules(agentModules, workflowModules, channelModules);',
		);
		expect(entry).toContain('workflows.find((record) => record.name === workflowName)?.definition');
		expect(entry).toContain("const INTERNAL_WORKFLOW_INVOKE_PATH = '/_flue/internal/workflow-invoke'");
		expect(entry).toContain("doInstance.runFiber('flue:workflow:' + runId");
		expect(entry).toContain('const admission = Promise.withResolvers();');
		expect(entry).toContain('return { admitted: admission.promise, completion };');
		expect(entry).toContain(
			'const workflow = workflows.find((record) => record.name === workflowName)?.definition',
		);
	});

	it('passes temporary local HTTP exposure into runtime configuration', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({ temporaryLocalExposure: true }),
		);

		expect(entry).toContain('temporaryLocalExposure: true');
	});

	it('imports discovered channels and configures their normalized handlers', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				channels: [{ name: 'slack', filePath: '/fixture/channels/slack.ts' }],
			}),
		);

		expect(entry).toContain('"/fixture/channels/slack.ts"');
		expect(entry).toContain('normalizeBuiltModules(agentModules, workflowModules, channelModules)');
		expect(entry).toContain('channelHandlers,');
	});
});

function testBuildContext(overrides: Partial<BuildContext> = {}): BuildContext {
	return {
		agents: [],
		workflows: [],
		channels: [],
		root: '/fixture',
		output: '/fixture/dist',
		runtimeVersion: '0.0.0-test',
		...overrides,
	};
}
