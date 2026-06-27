import { describe, expect, it } from 'vitest';
import { NodePlugin } from '../src/lib/build-plugin-node.ts';
import type { BuildContext } from '../src/lib/types.ts';

describe('NodePlugin', () => {
	it('uses the default sqlite adapter when no db.ts is present', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(entry).toContain('sqlite()');
		expect(entry).not.toContain('/fixture/db.ts');
	});

	it('wires a user-supplied db.ts instead of the default adapter', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				dbEntry: '/fixture/db.ts',
			}),
		);

		expect(entry).toContain('"/fixture/db.ts"');
		expect(entry).not.toContain('sqlite()');
		expect(entry).toContain('submissions: executionStore.submissions');
		expect(entry).toContain('conversationStreamStore,');
		expect(entry).toContain('attachmentStore,');
		expect(entry).not.toContain('executionStore.sessions');
		expect(entry).not.toContain('defaultStore:');
	});

	it('composes user app.ts when present and falls back to the default app', () => {
		const withApp = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				appEntry: '/fixture/app.ts',
			}),
		);

		expect(withApp).toContain('"/fixture/app.ts"');
		expect(withApp).not.toContain('createDefaultFlueApp()');

		const withoutApp = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(withoutApp).toContain('createDefaultFlueApp()');
		expect(withoutApp).not.toContain('/fixture/app.ts');
	});

	it('loads user app.ts inside instrumentation ownership and disposes it during shutdown', () => {
		const entry = new NodePlugin().generateRuntimeEntryPoint(
			testBuildContext({ appEntry: '/fixture/app.ts' }),
		);

		expect(entry).not.toContain('import userApp from');
		expect(entry).toContain('runWithInstrumentationOwner(instrumentationOwner, async () => {');
		expect(entry).toContain('const { default: userApp } = await import("/fixture/app.ts");');
		expect(entry).toContain('await instrumentationOwner.dispose();');
	});

	it('closes the persistence adapter on shutdown signals', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				dbEntry: '/fixture/db.ts',
			}),
		);

		expect(entry).toContain('persistenceAdapter.close');
		expect(entry).toContain("process.on('SIGINT'");
		expect(entry).toContain("process.on('SIGTERM'");
	});

	it('passes normalized Workflow route and runs middleware through runtime configuration', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				workflows: [{ name: 'report', filePath: '/fixture/workflows/report.ts' }],
			}),
		);

		expect(entry).toContain("if (typeof mod.route === 'function') workflow.route = mod.route;");
		expect(entry).toContain("if (typeof mod.runs === 'function') workflow.runs = mod.runs;");
		expect(entry).toContain('configureFlueRuntime({');
		expect(entry).toContain('workflows,');
	});

	it('wires ambient workflow invocation directly to detached in-process admission', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				workflows: [{ name: 'report', filePath: '/fixture/workflows/report.ts' }],
			}),
		);

		expect(entry).toContain('const { agents, workflows, channelHandlers } = normalized;');
		expect(entry).toContain('workflows.find((record) => record.name === workflowName)?.definition');
		expect(entry).toContain('admitDetachedWorkflow({');
		expect(entry).not.toContain("flueApp.fetch(new Request('https://flue.invalid/_internal/workflows/");
	});

	it('passes temporary local HTTP exposure into runtime configuration', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({ temporaryLocalExposure: true }),
		);

		expect(entry).toContain('temporaryLocalExposure: true');
	});

	it('keeps process lifecycle handlers out of the reusable local runtime', () => {
		const plugin = new NodePlugin();
		const context = testBuildContext({
			agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
		});

		const runtimeEntry = plugin.generateRuntimeEntryPoint(context);
		const deploymentEntry = plugin.generateEntryPoint(context);

		expect(runtimeEntry).not.toContain("process.on('SIGINT'");
		expect(runtimeEntry).not.toContain('process.exit(');
		expect(deploymentEntry).toContain("process.on('SIGINT'");
		expect(deploymentEntry).toContain('process.exit(');
	});

	it('restores scoped output and aggregates application cleanup failures', () => {
		const entry = new NodePlugin().generateRuntimeEntryPoint(testBuildContext());

		expect(entry).toContain('outputContext.exit(() => options.onOutput');
		expect(entry).toContain('restoreOutput();');
		expect(entry).toContain('new AggregateError(errors');
	});

	it('imports discovered channels and configures their normalized handlers', () => {
		const entry = new NodePlugin().generateEntryPoint(
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
		...overrides,
	};
}
