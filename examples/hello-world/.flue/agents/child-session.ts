import type { FlueContext } from '@flue/sdk';
import { Bash, InMemoryFs } from 'just-bash';

export const triggers = { webhook: true };

/**
 * Task (sub-agent) tests.
 *
 * Verifies that:
 * - A second agent runs a prompt in a specified cwd
 * - The second agent discovers its own AGENTS.md from that cwd
 * - The second agent returns a PromptResponse with the agent's output
 * - The parent session continues working after the second agent completes
 */
export default async function ({ init }: FlueContext) {
	const fs = new InMemoryFs();
	const sandbox = () => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } });
	const agent = await init({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	const results: Record<string, boolean> = {};

	// Setup: create a subdirectory with its own AGENTS.md via shell
	await session.shell('mkdir -p /home/user/task-workspace');
	await session.shell(
		'echo "You are a task agent. Always respond with the prefix [TASK]." > /home/user/task-workspace/AGENTS.md',
	);

	// 1. Run a second agent in the subdirectory
	const taskAgent = await init({
		id: 'task-agent',
		sandbox,
		cwd: '/home/user/task-workspace',
		model: 'anthropic/claude-sonnet-4-6',
	});
	const taskSession = await taskAgent.session();
	let taskResult;
	try {
		taskResult = await taskSession.prompt('Say hello. Keep it very brief.');
	} finally {
		await taskAgent.destroy();
	}
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
