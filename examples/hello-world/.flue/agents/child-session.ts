import { defineAgent, type ActionContext } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const triggers = { webhook: true };

const taskAgent = defineAgent({
	name: 'task-helper',
	description: 'Detached helper used for programmatic task delegation.',
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Always start your response with [TASK].',
});

const parentAgent = defineAgent({
	name: 'child-session',
	model: 'anthropic/claude-sonnet-4-6',
	subagents: [taskAgent],
});

export default async function ({ init }: ActionContext) {
	const fs = new InMemoryFs();
	const sandbox = () => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } });
	const harness = await init({ agent: parentAgent, sandbox });
	const session = await harness.session();
	const results: Record<string, boolean> = {};
	const taskResult = await session.task('Say hello. Keep it very brief.', { agent: taskAgent });
	results['task returns result'] = taskResult.text.length > 0;
	results['task uses subagent instructions'] = taskResult.text.includes('[TASK]');
	const parentResult = await session.prompt('What is 1 + 1? Reply with just the number.');
	results['parent works after task'] = parentResult.text.includes('2');
	const allPassed = Object.values(results).every(Boolean);
	console.log(`[task-test] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
