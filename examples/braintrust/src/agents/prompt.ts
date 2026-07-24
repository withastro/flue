'use agent';

import { useModel } from '@flue/runtime';

/** A plain prompting agent: each turn shows up as an `llm` span in Braintrust. */
export function Prompt() {
	useModel('anthropic/claude-haiku-4-5');
	return 'Write a one-sentence welcome for the person named in each message.';
}
