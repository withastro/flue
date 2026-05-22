import { describe, expect, it } from 'vitest';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('Node build plugin', () => {
	it('wires GitHub channel webhooks when an agent subscribes to github', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('createGitHubWebhook');
		expect(entry).toContain('github: createGitHubWebhook()');
		expect(entry).toContain('channelHandlers,');
	});
});

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'triage', filePath: '/tmp/triage.ts', channels: { github: true }, hasReceive: true, hasInit: true }],
		workflows: [],
		manifest: {
			agents: [{ name: 'triage', channels: { github: true }, receive: true, init: true }],
			workflows: [],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'node' },
	};
}
