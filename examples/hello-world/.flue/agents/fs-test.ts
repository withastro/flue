import type { FlueContext } from '@flue/sdk';

export const triggers = { webhook: true };

/**
 * Filesystem tests.
 *
 * Verifies that:
 * - Agents can read workspace files through the overlay
 * - LLM-driven prompts can write files via tools
 * - Writes are visible within the same session (via shell)
 * - Shell can create files (non-LLM path)
 */
export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	const results: Record<string, boolean> = {};

	// 1. Read a workspace file via shell
	const cat = await session.shell('cat AGENTS.md');
	const original = cat.stdout.trim();
	results['read workspace file'] = original.length > 0;
	console.log('[fs-test] read workspace file:', results['read workspace file'] ? 'PASS' : 'FAIL');

	// 2. LLM writes a file via prompt (uses tools: write, bash, etc.)
	await session.prompt(
		'Create a file called "hello.txt" in the current directory. ' +
			'Its contents should be exactly: Hello from the agent',
	);
	const written = await session.shell('cat hello.txt');
	results['llm write file'] = written.stdout.trim() === 'Hello from the agent';
	console.log('[fs-test] llm write file:', results['llm write file'] ? 'PASS' : 'FAIL');

	// 3. LLM modifies an existing workspace file via prompt
	await session.prompt(
		'Read the file AGENTS.md, then overwrite it with exactly this content: MODIFIED BY AGENT',
	);
	const modified = await session.shell('cat AGENTS.md');
	results['llm overwrite workspace file'] = modified.stdout.trim() === 'MODIFIED BY AGENT';
	console.log(
		'[fs-test] llm overwrite workspace file:',
		results['llm overwrite workspace file'] ? 'PASS' : 'FAIL',
	);

	// 4. Shell can also create files (non-LLM path)
	await session.shell('echo "shell content" > shell-created.txt');
	const shellFile = await session.shell('cat shell-created.txt');
	results['shell write file'] = shellFile.stdout.trim() === 'shell content';
	console.log('[fs-test] shell write file:', results['shell write file'] ? 'PASS' : 'FAIL');

	const allPassed = Object.values(results).every(Boolean);
	console.log(`[fs-test] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
