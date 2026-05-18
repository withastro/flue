import type { ActionContext } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const triggers = { webhook: true };

export default async function ({ init }: ActionContext) {
	const fs = new InMemoryFs();
	const sandbox = () => new Bash({ fs });
	const harness = await init({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();
	const results: Record<string, boolean> = {};
	await session.shell('echo "Seeded workspace text" > workspace.txt');
	const cat = await session.shell('cat workspace.txt');
	results['read workspace file'] = cat.stdout.trim().length > 0;
	await session.prompt(
		'Create a file called "hello.txt" in the current directory. ' +
			'Its contents should be exactly: Hello from the agent',
	);
	const written = await session.shell('cat hello.txt');
	results['llm write file'] = written.stdout.trim() === 'Hello from the agent';
	await session.prompt(
		'Read the file workspace.txt, then overwrite it with exactly this content: MODIFIED BY AGENT',
	);
	const modified = await session.shell('cat workspace.txt');
	results['llm overwrite workspace file'] = modified.stdout.trim() === 'MODIFIED BY AGENT';
	await session.shell('echo "shell content" > shell-created.txt');
	const shellFile = await session.shell('cat shell-created.txt');
	results['shell write file'] = shellFile.stdout.trim() === 'shell content';
	const allPassed = Object.values(results).every(Boolean);
	console.log(`[fs-test] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
