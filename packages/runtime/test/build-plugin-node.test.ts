import { describe, expect, it } from 'vite-plus/test';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('NodePlugin', () => {
	it('generates correct agent and workflow imports and handler maps', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				workflows: [{ name: 'translate', filePath: '/fixture/workflows/translate.ts' }],
			}),
		);

		expect(entry).toContain('import * as handler_assistant_0 from "/fixture/agents/assistant.ts";');
		expect(entry).toContain(
			'import * as workflow_translate_0 from "/fixture/workflows/translate.ts";',
		);
		expect(entry).toContain('"assistant": handler_assistant_0,');
		expect(entry).toContain('"translate": workflow_translate_0,');
	});

	it('uses the default in-memory execution store when no db.ts is present', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(entry).toContain('createNodeAgentExecutionStore()');
		expect(entry).not.toContain('userPersistenceAdapter');
	});

	it('wires a user-supplied db.ts with migrate and connect validation', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				dbEntry: '/fixture/db.ts',
			}),
		);

		expect(entry).toContain('import userPersistenceAdapter from "/fixture/db.ts";');
		expect(entry).toContain("typeof userPersistenceAdapter.connect !== 'function'");
		expect(entry).toContain('userPersistenceAdapter.migrate');
		expect(entry).toContain('userPersistenceAdapter.connect()');
		expect(entry).not.toContain('createNodeAgentExecutionStore()');
	});

	it('creates the agent coordinator with reconciliation and dispatch queue', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(entry).toContain('createNodeAgentCoordinator');
		expect(entry).toContain('executionStore.submissions');
		expect(entry).toContain('createNodeDispatchQueue(agentCoordinator)');
		expect(entry).toContain('agentCoordinator.reconcileSubmissions()');
	});

	it('composes user app.ts when present and falls back to default app', () => {
		const withApp = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				appEntry: '/fixture/app.ts',
			}),
		);

		expect(withApp).toContain('import userApp from "/fixture/app.ts";');
		expect(withApp).toContain('const flueApp = userApp;');
		expect(withApp).not.toContain('createDefaultFlueApp()');

		const withoutApp = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
			}),
		);

		expect(withoutApp).toContain('createDefaultFlueApp()');
		expect(withoutApp).not.toContain('userApp');
	});

	it('closes the user persistence adapter on shutdown signals', () => {
		const entry = new NodePlugin().generateEntryPoint(
			testBuildContext({
				agents: [{ name: 'assistant', filePath: '/fixture/agents/assistant.ts' }],
				dbEntry: '/fixture/db.ts',
			}),
		);

		expect(entry).toContain('userPersistenceAdapter.close');
		expect(entry).toContain("process.on('SIGINT'");
		expect(entry).toContain("process.on('SIGTERM'");
	});
});

function testBuildContext(overrides: Partial<BuildContext> = {}): BuildContext {
	return {
		agents: [],
		workflows: [],
		root: '/fixture',
		output: '/fixture/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/fixture', sourceRoot: '/fixture', target: 'node' },
		...overrides,
	};
}
