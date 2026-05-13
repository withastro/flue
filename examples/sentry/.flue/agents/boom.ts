/**
 * Run-fatal failure agent.
 *
 * This handler throws unconditionally. Flue catches the throw,
 * emits a `run_end` event with `isError: true` and a serialized
 * error payload, then returns an HTTP error envelope to the caller.
 *
 * The `observe(...)` subscriber in `app.ts` sees the `run_end`
 * event, reconstructs the Error, and calls `Sentry.captureException`
 * with `flue.run_id`, `flue.instance_id`, and friends as tags.
 *
 * Invoke:
 *
 *   curl -X POST http://localhost:3583/agents/boom/test1 \
 *     -H 'content-type: application/json' \
 *     -d '{}'
 *
 * Expected:
 *   - HTTP 500 from Flue with a structured error envelope.
 *   - One issue in Sentry, tagged `flue.agent=boom`, `flue.run_id=run_...`.
 *
 * Notice: the handler does not import Sentry. It does not know that
 * error reporting exists. That separation is the whole point — every
 * Flue agent in this project is instrumented for Sentry by virtue of
 * living in this project, without any per-agent boilerplate.
 */
import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

export default async function boom(ctx: FlueContext) {
	// `log.info` is just a normal Flue structured log. It appears in
	// the run's event stream (and in `flue logs <runId>`) but is NOT
	// sent to Sentry — only `log.error` is.
	ctx.log.info('boom agent about to explode', { reason: 'demo' });

	throw new Error('intentional explosion for the Sentry demo');
}
