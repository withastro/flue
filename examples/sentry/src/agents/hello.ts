'use agent';
import { useModel, useTool } from '@flue/runtime';

/**
 * The success case: logs at info level and returns a value. Raises no Sentry
 * issue — the info log arrives in Sentry Logs, and the conversation shows up
 * as a trace when tracing is enabled.
 */
export function Hello() {
	useModel('anthropic/claude-haiku-4-5');
	useTool({
		name: 'hello',
		description: 'Log an info line and return a greeting. The no-issue success case.',
		run({ log }) {
			log.info('hello action starting');
			return { greeting: 'hello from flue' };
		},
	});
	return 'When asked to run the demo, call the `hello` action and report its result.';
}
