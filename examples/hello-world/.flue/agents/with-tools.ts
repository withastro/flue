import { Type, type FlueContext, type ToolDef } from '@flue/sdk/client';

export const triggers = { webhook: true };

/**
 * Custom tools + task tool test.
 *
 * Verifies that:
 * - Custom tools can be passed to session.prompt()
 * - The LLM can call custom tools and receives the result
 * - Custom tools with the same name as a built-in tool are rejected
 * - An inline task tool (using session.task()) creates a working sub-agent
 */
export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

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

	const response = await session.prompt(
		'Use the calculator tool to compute 7 * 6. Tell me the result.',
		{ tools: [calculator] },
	);
	results['custom tool works'] = response.text.includes('42');
	console.log('[with-tools] custom tool works:', results['custom tool works'] ? 'PASS' : 'FAIL');

	// ─── Test 2: Built-in name collision ────────────────────────────────────

	const conflicting: ToolDef = {
		name: 'read',
		description: 'This should fail because "read" is a built-in tool.',
		parameters: Type.Object({}),
		execute: async () => 'nope',
	};

	try {
		await session.prompt('test', { tools: [conflicting] });
		results['builtin collision rejected'] = false;
	} catch (err) {
		results['builtin collision rejected'] =
			err instanceof Error && err.message.includes('conflicts with a built-in tool');
	}
	console.log(
		'[with-tools] builtin collision rejected:',
		results['builtin collision rejected'] ? 'PASS' : 'FAIL',
	);

	// ─── Test 3: Inline task tool (session.task) ────────────────────────────

	// Write an AGENTS.md to a task directory so the sub-agent picks it up
	await session.shell('mkdir -p /home/user/task-workspace');
	await session.shell(
		'echo "You are a math helper. Always respond with just the numeric answer, nothing else." > /home/user/task-workspace/AGENTS.md',
	);

	const taskTool: ToolDef = {
		name: 'task',
		description:
			'Delegate a task to a focused agent working in a specific directory. ' +
			'The agent automatically discovers and follows any AGENTS.md instructions ' +
			'and skills found in that directory.',
		parameters: Type.Object({
			workspace: Type.String({
				description:
					'The directory the agent should work in (AGENTS.md and skills are auto-discovered)',
			}),
			prompt: Type.String({ description: 'The task or instructions for the agent' }),
		}),
		execute: async (args) => {
			const result = await session.task(args.prompt, { workspace: args.workspace });
			return result.text;
		},
	};

	const taskResponse = await session.prompt(
		'Use the task tool to ask the agent at /home/user/task-workspace: "What is 100 + 23?"',
		{ tools: [taskTool] },
	);
	results['task tool works'] = taskResponse.text.includes('123');
	console.log('[with-tools] task tool works:', results['task tool works'] ? 'PASS' : 'FAIL');

	// ─── Summary ────────────────────────────────────────────────────────────

	const allPassed = Object.values(results).every(Boolean);
	console.log(`[with-tools] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
