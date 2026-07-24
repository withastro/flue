'use agent';
import { bash, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export function WithCustomBash() {
	useModel('anthropic/claude-haiku-4-5');
	const fs = new InMemoryFs();
	useSandbox(bash(() => new Bash({ fs })));
	useTool({
		name: 'prove-custom-bash',
		description: 'Write and read a file inside the customized virtual sandbox.',
		harness: true,
		async run({ harness }) {
			await harness.sandbox.exec('echo "custom bash succeeded" > proof.txt');
			return { text: (await harness.sandbox.exec('cat proof.txt')).stdout.trim() };
		},
	});
	return 'When asked to run the demo, call the `prove-custom-bash` action and report its result.';
}
