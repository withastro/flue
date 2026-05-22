import { describe, expect, it } from 'vitest';
import { CloudflarePlugin } from '../../cli/src/lib/build-plugin-cloudflare.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('Cloudflare build plugin', () => {
	it('fails external-channel dispatch processing clearly instead of using memory fallback', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('Cloudflare external-channel dispatch processing is not supported yet');
		expect(entry).toContain('Dispatch must route to the target agent Durable Object');
		expect(entry).not.toContain('createAgentDispatchProcessor');
		expect(entry).not.toContain('createContextForRequest(id, runId, payload, undefined, req)');
	});

	it('threads generated Durable Object identity through Cloudflare context', async () => {
		const entry = await new CloudflarePlugin().generateEntryPoint(testBuildContext());

		expect(entry).toContain('const agentClassNames = {');
		expect(entry).toContain('"moderator": "Moderator"');
		expect(entry).toContain('const workflowClassNames = {');
		expect(entry).toContain('"daily-report": "DailyReportWorkflow"');
		expect(entry).toContain('durableObjectIdentity: createDurableObjectIdentity(doInstance, identity)');
		expect(entry).toContain('bindingName: workflowBindingNameFromWorkflowName(workflowName)');
		expect(entry).toContain('bindingName: agentBindingNameFromAgentName(agentName)');
		expect(entry).not.toContain('createRegistryIdentity');
	});

});

function testBuildContext(): BuildContext {
	return {
		agents: [{ name: 'moderator', filePath: '/tmp/moderator.ts', hasChannels: true, hasReceive: true, hasInit: true }],
		workflows: [{ name: 'daily-report', filePath: '/tmp/daily-report.ts', hasChannels: true }],
		manifest: {
			agents: [{ name: 'moderator', channels: {}, receive: true, init: true }],
			workflows: [{ name: 'daily-report', channels: {} }],
		},
		root: '/tmp/flue-test',
		output: '/tmp/flue-test/dist',
		runtimeVersion: '0.0.0-test',
		options: { root: '/tmp/flue-test', target: 'cloudflare' },
	};
}
