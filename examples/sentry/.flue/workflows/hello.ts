/**
 * Successful baseline agent.
 *
 * This agent always returns cleanly. Use it to confirm the integration
 * is wired up *without* producing Sentry traffic — a healthy run
 * emits no `run_end { isError: true }` and no `log { level: 'error' }`,
 * so the bridge in `app.ts` makes zero capture calls.
 *
 * Invoke:
 *
 *   curl -X POST http://localhost:3583/workflows/hello?wait=result \
 *     -H 'content-type: application/json' \
 *     -d '{}'
 *
 * Expected: HTTP 200 with `{ result: ..., _meta: { runId } }`.
 *          Zero events in Sentry.
 */
import { http, type FlueContext } from '@flue/runtime';

export const channels = [http()];

export async function run(ctx: FlueContext) {
	ctx.log.info('hello agent starting', { instanceId: ctx.id });
	// No model call needed for the success case — this keeps the
	// example runnable without an ANTHROPIC_API_KEY when you just
	// want to verify the Sentry wiring.
	return { greeting: 'hello from flue', id: ctx.id };
}
