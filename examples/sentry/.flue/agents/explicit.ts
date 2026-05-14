/**
 * Non-fatal, handler-reported failure.
 *
 * The agent catches an internal error itself and reports it via
 * `ctx.log.error(...)`. The run completes successfully from Flue's
 * perspective — the HTTP response is a normal 200 — but Sentry
 * still receives an exception so the operator knows something went
 * wrong inside the run.
 *
 * This is the pattern to reach for when:
 *
 *   - A non-critical subtask failed but the overall run can still
 *     produce a useful result.
 *   - You want to log a known-but-rare degradation (e.g. fallback to
 *     a slower model) as a Sentry issue without crashing the run.
 *   - You want richer attributes attached to the capture than the
 *     run-fatal path provides automatically.
 *
 * Two log shapes are exercised below, mirroring how the bridge in
 * `app.ts` routes them:
 *
 *   1. `log.error(msg, { error })`   →  Sentry.captureException
 *   2. `log.error(msg, { ...info })` →  Sentry.captureMessage
 *
 * Invoke:
 *
 *   curl -X POST http://localhost:3583/agents/explicit/test1 \
 *     -H 'content-type: application/json' \
 *     -d '{}'
 *
 * Expected:
 *   - HTTP 200 with `{ result: { ok: true, ... }, _meta: { runId } }`.
 *   - Two issues in Sentry, both tagged `flue.agent=explicit`.
 */
import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

export default async function explicit(ctx: FlueContext) {
	// Pretend we tried to call a flaky downstream service and it
	// threw. We catch the error so the run continues, but we still
	// want it captured in Sentry as an exception.
	try {
		throw new TypeError('downstream service returned an unexpected shape');
	} catch (error) {
		ctx.log.error('flaky downstream call failed; continuing with fallback', {
			error,
			service: 'fictional-pricing-api',
			retriable: false,
		});
	}

	// A second flavor: no `error` attribute, just a structured
	// message. The bridge captures this as `Sentry.captureMessage`
	// at `error` level, with the attributes attached as scope
	// context.
	ctx.log.error('low-confidence model output rejected', {
		confidence: 0.21,
		threshold: 0.5,
		action: 'fell back to deterministic path',
	});

	return {
		ok: true,
		runId: ctx.runId,
		// In a real handler, this would be the fallback result.
		fallbackUsed: true,
	};
}
