'use agent';
import { useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

export function WithThinking() {
	useModel('anthropic/claude-haiku-4-5', { thinkingLevel: 'low' });
	useTool({
		name: 'thinking-test',
		description: 'Compare per-call thinking-level overrides in the harness conversation.',
		harness: true,
		async run({ harness }) {
			const Answer = v.object({ answer: v.string() });
			const fast = await harness.prompt('In one word: capital of France?', { result: Answer });
			const careful = await harness.prompt('Is 1009 prime? Justify briefly.', {
				result: Answer,
				thinkingLevel: 'high',
			});
			const minimal = await harness.prompt('Echo back: hello', {
				result: Answer,
				thinkingLevel: 'minimal',
			});
			return { fast: fast.data, careful: careful.data, minimal: minimal.data };
		},
	});
	return 'When asked to run a demo, call the `thinking-test` tool and report its result.';
}
