'use agent';
import { useModel, useTool } from '@flue/runtime';

/**
 * The non-fatal case: the handler reports errors with `log.error` and keeps
 * going. Each `log.error` arrives in Sentry Logs at error level — on the
 * conversation's trace when tracing is enabled — while the conversation
 * completes normally and raises no issue.
 */
export function Explicit() {
	useModel('anthropic/claude-haiku-4-5');
	useTool({
		name: 'explicit',
		description:
			'Report recoverable errors with log.error (with and without an error attribute) and continue.',
		run({ log }) {
			try {
				throw new TypeError('downstream service returned an unexpected shape');
			} catch (error) {
				log.error('flaky downstream call failed; continuing with fallback', {
					error,
					service: 'fictional-pricing-api',
					retriable: false,
				});
			}
			log.error('low-confidence model output rejected', {
				confidence: 0.21,
				threshold: 0.5,
				action: 'fell back to deterministic path',
			});
			return { ok: true, fallbackUsed: true };
		},
	});
	return 'When asked to run the demo, call the `explicit` action and report its result.';
}
