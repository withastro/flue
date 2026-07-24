'use agent';
import { bash, defineTool, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import * as v from 'valibot';

export function WithTools() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox(
		bash(
			() =>
				new Bash({ fs: new InMemoryFs(), network: { dangerouslyAllowFullInternetAccess: true } }),
		),
	);
	useTool({
		name: 'tools-test',
		description: 'Exercise a per-prompt custom tool and the task tool.',
		harness: true,
		async run({ harness }) {
			const results: Record<string, boolean> = {};
			const calculator = defineTool({
				name: 'calculator',
				description: 'Perform arithmetic. Returns the numeric result as a string.',
				input: v.object({ expression: v.string() }),
				run: async ({ data }) => String(Function(`"use strict"; return (${data.expression})`)()),
			});
			const { text } = await harness.prompt(
				'Use the calculator tool to compute 7 * 6. Tell me the result.',
				{ tools: [calculator] },
			);
			results['custom tool works'] = text.includes('42');
			await harness.sandbox.exec('mkdir -p /home/user/task-workspace');
			await harness.sandbox.exec(
				'echo "You are a math helper. Always respond with just the numeric answer, nothing else." > /home/user/task-workspace/AGENTS.md',
			);
			const taskResponse = await harness.prompt(
				'Use the task tool with cwd /home/user/task-workspace to ask: "What is 100 + 23?"',
			);
			results['task tool works'] = taskResponse.text.includes('123');
			return { results, allPassed: Object.values(results).every(Boolean) };
		},
	});
	return 'When asked to run a demo, call the `tools-test` tool and report its result.';
}
