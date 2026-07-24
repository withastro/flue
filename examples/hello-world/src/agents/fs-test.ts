'use agent';
import { bash, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export function FsTest() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox(bash(() => new Bash({ fs: new InMemoryFs() })));
	useTool({
		name: 'fs-test',
		description: 'Verify shell and model file access inside a custom bash sandbox.',
		harness: true,
		async run({ harness }) {
			const results: Record<string, boolean> = {};
			await harness.sandbox.exec('echo "Seeded workspace instructions" > AGENTS.md');
			results['read workspace file'] =
				(await harness.sandbox.exec('cat AGENTS.md')).stdout.trim().length > 0;
			await harness.prompt(
				'Create a file called "hello.txt" in the current directory. Its contents should be exactly: Hello from the agent',
			);
			results['llm write file'] =
				(await harness.sandbox.exec('cat hello.txt')).stdout.trim() === 'Hello from the agent';
			await harness.prompt(
				'Read the file AGENTS.md, then overwrite it with exactly this content: MODIFIED BY AGENT',
			);
			results['llm overwrite workspace file'] =
				(await harness.sandbox.exec('cat AGENTS.md')).stdout.trim() === 'MODIFIED BY AGENT';
			await harness.sandbox.exec('echo "shell content" > shell-created.txt');
			results['shell write file'] =
				(await harness.sandbox.exec('cat shell-created.txt')).stdout.trim() === 'shell content';
			return { results, allPassed: Object.values(results).every(Boolean) };
		},
	});
	return 'When asked to run a demo, call the `fs-test` tool and report its result.';
}
