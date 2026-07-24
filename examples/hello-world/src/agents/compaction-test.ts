'use agent';
import { bash, useModel, useSandbox, useTool } from '@flue/runtime';
import { Bash, InMemoryFs } from 'just-bash';
import * as v from 'valibot';

export function CompactionTest() {
	useModel('anthropic/claude-sonnet-4-6');
	useSandbox(
		bash(
			() =>
				new Bash({ fs: new InMemoryFs(), network: { dangerouslyAllowFullInternetAccess: true } }),
		),
	);
	useTool({
		name: 'compaction-test',
		description:
			'Fill the harness conversation with a large article and verify recall across compaction.',
		harness: true,
		async run({ harness }) {
			await harness.prompt(
				'Use bash to fetch this Wikipedia article and summarize it in 2-3 sentences:\n' +
					'curl -sL "https://en.wikipedia.org/w/index.php?title=History_of_the_Internet&action=raw"',
			);
			const { data } = await harness.prompt(
				'What Wikipedia article did you just read? What were the key points? Return a structured result.',
				{ result: v.object({ article: v.string(), keyPoints: v.array(v.string()) }) },
			);
			return data;
		},
	});
	return 'When asked to run a demo, call the `compaction-test` tool and report its result.';
}
