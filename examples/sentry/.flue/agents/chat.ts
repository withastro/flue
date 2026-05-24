/**
 * Chat agent — exercises the full gen_ai tracing pipeline.
 *
 * Calls the LLM via `session.prompt()`, producing `turn` events that
 * the bridge in `app.ts` translates into gen_ai.chat spans. Requires
 * ANTHROPIC_API_KEY (or whichever provider matches the model).
 *
 * Invoke:
 *
 *   curl -X POST http://localhost:3583/agents/chat/test1 \
 *     -H 'content-type: application/json' \
 *     -d '{ "message": "What is the capital of France?" }'
 *
 * Expected:
 *   - HTTP 200 with `{ reply, usage, _meta: { runId } }`.
 *   - In Sentry: an invoke_agent span containing one or more chat spans.
 *   - In Sentry Logs: structured log entries for the run lifecycle.
 */
import type { FlueContext } from '@flue/runtime';

export const triggers = { webhook: true };

export default async function chat(ctx: FlueContext) {
	const message = ctx.payload?.message ?? 'Say hello in one sentence.';

	ctx.log.info('chat agent invoked', { message });

	const harness = await ctx.init({ model: 'anthropic/claude-sonnet-4-6' });
	const session = await harness.session();
	const { text, usage } = await session.prompt(message);

	ctx.log.info('chat agent completed', {
		inputTokens: usage.input,
		outputTokens: usage.output,
		totalCost: usage.cost.total,
	});

	return { reply: text, usage };
}
