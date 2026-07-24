'use agent';
import { useModel, useSubagent } from '@flue/runtime';

/** A delegating agent: `session.task` delegations show up as `task` spans in Braintrust. */
export function Task() {
	useModel('anthropic/claude-haiku-4-5');
	useSubagent({
		name: 'editor',
		description: 'Rewrites the supplied sentence in a clearer, shorter form.',
		agent: () => 'Rewrite the supplied sentence in a clearer, shorter form.',
	});
	return 'Delegate every rewrite request to the `editor` subagent with the task tool, then return its result verbatim.';
}
