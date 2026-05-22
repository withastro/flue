import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { build } from '../../cli/src/lib/build.ts';
import { NodePlugin } from '../../cli/src/lib/build-plugin-node.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('Node build plugin', () => {
	it('wires GitHub channel webhooks when an agent subscribes to github', () => {
		const entry = new NodePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('createGitHubWebhook');
		expect(entry).toContain('github: createGitHubWebhook({ secret: process.env.GITHUB_WEBHOOK_SECRET })');
		expect(entry).toContain('channelHandlers,');
	});

	it('rejects duplicate agent basenames', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flue-duplicate-agents-'));
		fs.mkdirSync(path.join(root, 'agents'));
		fs.writeFileSync(path.join(root, 'agents', 'assistant.ts'), 'export async function init() {}\n');
		fs.writeFileSync(path.join(root, 'agents', 'assistant.js'), 'export async function init() {}\n');

		await expect(build({ root, target: 'node' })).rejects.toThrow('Duplicate agent basename "assistant"');
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
