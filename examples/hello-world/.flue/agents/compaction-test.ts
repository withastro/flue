import type { FlueContext } from '@flue/sdk';
import * as v from 'valibot';

export const triggers = { webhook: true };

export default async function ({ init }: FlueContext) {
	const agent = await init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await agent.session();

	// Turn 1: Fetch one Wikipedia article. Raw wikitext truncated to ~50KB by bash tool = ~12k tokens.
	// With system prompt + user message overhead, total context should be ~14-15k tokens,
	// which will trigger compaction (threshold set to 15k for testing).
	console.log('[compaction-test] Turn 1: Fetching Wikipedia article via curl...');
	await session.prompt(
		'Use bash to fetch this Wikipedia article and summarize it in 2-3 sentences:\n' +
			'curl -sL "https://en.wikipedia.org/w/index.php?title=History_of_the_Internet&action=raw"',
	);

	// Compaction should have triggered after turn 1. Turn 2 verifies the agent
	// still knows what it read (via the compaction summary).
	console.log('[compaction-test] Turn 2: Verifying post-compaction memory...');
	const response = await session.prompt(
		'What Wikipedia article did you just read? What were the key points? Return a structured result.',
		{
			result: v.object({
				article: v.string(),
				keyPoints: v.array(v.string()),
			}),
		},
	);

	const result = response.result;
	console.log(
		`[compaction-test] Result: ${result.article} — ${result.keyPoints.length} key points`,
	);
	return result;
}
