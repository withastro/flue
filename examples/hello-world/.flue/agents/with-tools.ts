import { Type, type FlueContext, type ToolDef } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const triggers = { webhook: true };

/**
 * Custom tools + delegated agent tool test.
 *
 * Verifies that:
 * - Custom tools can be passed to session.prompt()
 * - The LLM can call custom tools and receives the result
 * - The built-in task tool can delegate to another agent rooted at a different cwd
 */
export default async function ({ init }: FlueContext) {
	const fs = new InMemoryFs();
	const sandbox = () => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } });
	const harness = await init({ sandbox, model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();

	const results: Record<string, boolean> = {};

	// ─── Test 1: Simple custom tool ─────────────────────────────────────────

	const calculator: ToolDef = {
		name: 'calculator',
		description: 'Perform arithmetic. Returns the numeric result as a string.',
		parameters: Type.Object({
			expression: Type.String({ description: 'A math expression like "2 + 3"' }),
		}),
		execute: async (args) => {
			// Simple eval for test purposes (only supports basic arithmetic)
			const expr = args.expression as string;
			const result = Function(`"use strict"; return (${expr})`)();
			return String(result);
		},
	};

	const { text } = await session.prompt(
		'Use the calculator tool to compute 7 * 6. Tell me the result.',
		{ tools: [calculator] },
	);
	results['custom tool works'] = text.includes('42');
	console.log('[with-tools] custom tool works:', results['custom tool works'] ? 'PASS' : 'FAIL');

	// ─── Test 2: Inline delegated agent tool ─────────────────────────────────

	// Write an AGENTS.md to a task directory so the sub-agent picks it up
	await session.shell('mkdir -p /home/user/task-workspace');
	await session.shell(
		'echo "You are a math helper. Always respond with just the numeric answer, nothing else." > /home/user/task-workspace/AGENTS.md',
	);

	const taskResponse = await session.prompt(
		'Use the task tool with cwd /home/user/task-workspace to ask: "What is 100 + 23?"',
	);
	results['task tool works'] = taskResponse.text.includes('123');
	console.log('[with-tools] task tool works:', results['task tool works'] ? 'PASS' : 'FAIL');

	// ─── Summary ────────────────────────────────────────────────────────────

	const allPassed = Object.values(results).every(Boolean);
	console.log(`[with-tools] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
