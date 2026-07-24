'use agent';
import { useModel } from '@flue/runtime';

/**
 * The terminal-failure case: this agent function throws when it renders, so
 * every durable submission sent to it fails. The bridge in `app.ts` captures
 * the failure as a Sentry exception (via the `submission_settled` event with
 * outcome `failed`, plus the failed operation's `operation` event).
 */
export function Boom(): string {
	useModel('anthropic/claude-haiku-4-5');
	throw new Error('intentional explosion for the Sentry demo');
}
