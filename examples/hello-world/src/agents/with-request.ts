'use agent';
import { useModel, useTool } from '@flue/runtime';

export function WithRequest() {
	useModel('anthropic/claude-haiku-4-5');
	useTool({
		name: 'greet',
		description: 'Ask the harness conversation for a five-word hello.',
		harness: true,
		async run({ harness }) {
			const { text } = await harness.prompt('Say hello in 5 words.');
			return { text };
		},
	});
	return 'When asked to run a demo, call the `greet` tool and report its result.';
}
