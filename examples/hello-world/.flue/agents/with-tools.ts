import { Type, defineAgent, defineTool, type ActionContext } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';

export const triggers = { webhook: true };

const mathHelper = defineAgent({
	name: 'math-helper',
	description: 'Answers delegated arithmetic tasks with only the numeric result.',
	model: 'anthropic/claude-haiku-4-5',
	instructions: 'Return only the numeric answer, with no extra text.',
});

const toolsAgent = defineAgent({
	name: 'with-tools',
	model: 'anthropic/claude-sonnet-4-6',
	subagents: [mathHelper],
});

const calculator = defineTool({
	name: 'calculator',
	description: 'Perform arithmetic. Returns the numeric result as a string.',
	parameters: Type.Object({
		expression: Type.String({ description: 'A math expression like "2 + 3"' }),
	}),
	execute: async (args) => {
		const expr = args.expression as string;
		const result = Function(`"use strict"; return (${expr})`)();
		return String(result);
	},
});

export default async function ({ init }: ActionContext) {
	const fs = new InMemoryFs();
	const sandbox = () => new Bash({ fs, network: { dangerouslyAllowFullInternetAccess: true } });
	const harness = await init({ agent: toolsAgent, sandbox });
	const session = await harness.session();
	const results: Record<string, boolean> = {};
	const { text } = await session.prompt(
		'Use the calculator tool to compute 7 * 6. Tell me the result.',
		{ tools: [calculator] },
	);
	results['custom tool works'] = text.includes('42');
	console.log('[with-tools] custom tool works:', results['custom tool works'] ? 'PASS' : 'FAIL');
	const taskResponse = await session.prompt(
		'Use the task tool with agent math-helper to ask: "What is 100 + 23?"',
	);
	results['task tool works'] = taskResponse.text.includes('123');
	console.log('[with-tools] task tool works:', results['task tool works'] ? 'PASS' : 'FAIL');
	const allPassed = Object.values(results).every(Boolean);
	console.log(`[with-tools] ${allPassed ? 'ALL PASSED' : 'SOME FAILED'}`);
	return { results, allPassed };
}
