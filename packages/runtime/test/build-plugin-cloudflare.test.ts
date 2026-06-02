import { describe, expect, it } from 'vitest';
import { CloudflarePlugin } from '../../cli/src/lib/build-plugin-cloudflare.ts';
import type { BuildContext } from '../../cli/src/lib/types.ts';

describe('CloudflarePlugin', () => {
	it('rejects generated Worker export collisions when an agent and workflow produce the same class name', async () => {
		await expect(
			new CloudflarePlugin().generateEntryPoint(
				testBuildContext({
					agents: [{ name: 'draft-workflow', filePath: '/fixture/agents/draft-workflow.ts' }],
					workflows: [{ name: 'draft', filePath: '/fixture/workflows/draft.ts' }],
				}),
			),
		).rejects.toThrow(
			'Cloudflare target generated conflicting Worker export name(s): "DraftWorkflow" (agent "draft-workflow", workflow "draft")',
		);
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
