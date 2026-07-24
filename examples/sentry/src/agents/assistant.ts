'use agent';
import { defineTool, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

const lookupOrder = defineTool({
	name: 'lookup_order',
	description: 'Look up the status of a demo order by its id.',
	input: v.object({ orderId: v.string() }),
	run({ data, log }) {
		log.info('looking up order', { orderId: data.orderId });
		return {
			orderId: data.orderId,
			status: 'shipped',
			eta: 'tomorrow',
			carrier: 'Flue Parcel Service',
		};
	},
});

/**
 * The tracing case: with SENTRY_TRACES_SAMPLE_RATE > 0, one prompt to this
 * agent produces a full trace in Sentry — `invoke_agent Assistant` with
 * `chat` and `execute_tool lookup_order` children, token usage on the model
 * spans — and the tool's info log lands in Sentry Logs on the same trace.
 */
export function Assistant() {
	useModel('anthropic/claude-haiku-4-5');
	useTool(lookupOrder);
	return 'You are a concise order-support agent. Always call the lookup_order tool before answering a question about an order.';
}
