import type { FlueContext } from '@flue/sdk';

export const triggers = { webhook: true };

/**
 * Task (sub-agent) tests.
 *
 * Verifies that:
 * - session.task() runs a prompt in a specified workspace
 * - The task discovers its own AGENTS.md from the workspace
 * - The task returns a PromptResponse with the agent's output
 * - The parent session continues working after the task completes
 */
export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	const results: Record<string, boolean> = {};

	// Setup: create a subdirectory with its own AGENTS.md via shell
	await session.shell('mkdir -p /home/user/task-workspace');
	await session.shell(
		'echo "You are a task agent. Always respond with the prefix [TASK]." > /home/user/task-workspace/AGENTS.md',
	);

	// 1. Run a task in the subdirectory
	const taskResult = await session.task('Say hello. Keep it very brief.', {
		workspace: '/home/user/task-workspace',
	});
	results['task returns result'] = taskResult.text.length > 0;
	console.log('[task-test] task returns result:', results['task returns result'] ? 'PASS' : 'FAIL');

	// 2. The task discovered its AGENTS.md (response should have [TASK] prefix)
	results['task discovers context'] = taskResult.text.includes('[TASK]');
	console.log(
		'[task-test] task discovers context:',
		results['task discovers context'] ? 'PASS' : 'FAIL',
	);

	// 3. Parent session still works after task completes
	const parentResult = await session.prompt('What is 1 + 1? Reply with just the number.');
	results['parent works after task'] = parentResult.text.includes('2');
	console.log(
		'[task-test] parent works after task:',
		results['parent works after task'] ? 'PASS' : 'FAIL',
	);

	const allPassed = Object.values(results).every(Boolean);
	console.log(`[task-test] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
