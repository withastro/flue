'use agent';
/**
 * Formerly a `defineAction` demo (and before that `src/workflows/demo.ts`).
 * Actions are gone: a background job is deterministic code in a model-callable
 * tool. This one needs no model access of its own, so it is a plain tool —
 * its progress lines stream through `ctx.log` and its structured result
 * returns through the conversation like any other tool call. (Code that must
 * drive models declares `harness: true` and receives `ctx.harness`.)
 */
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from '@earendil-works/pi-ai';
import { setProvider, useDataWriter, useModel, useTool } from '@flue/runtime';
import * as v from 'valibot';

// Scripted model so the demo runs fully offline. Module scope, not the agent
// body: the agent function is a render that may re-run. Responses are consumed
// one per model call, so the opening turn re-queues itself — one scripted
// run per user message, indefinitely.
const faux = fauxProvider({
	api: 'react-chat-demo',
	provider: 'react-chat-demo',
	models: [{ id: 'demo' }],
});
setProvider(faux.provider);
const closingTurn = () => fauxAssistantMessage(fauxText('Demo job completed.'));
const openingTurn: Parameters<typeof faux.setResponses>[0][number] = () => {
	faux.appendResponses([closingTurn, openingTurn]);
	return fauxAssistantMessage(fauxToolCall('run_demo', { requestedAt: new Date().toISOString() }), {
		stopReason: 'toolUse',
	});
};
faux.setResponses([openingTurn]);

export function Demo() {
	useModel('react-chat-demo/demo');
	// A live progress card streamed to the client. `useDataWriter` returns a
	// write-only function: the model never sees data parts, and repeated
	// writes to the same name update the same card in place.
	const writeJobCardData = useDataWriter('jobCard', {
		schema: v.object({
			status: v.picklist(['running', 'done']),
			step: v.string(),
		}),
	});
	useTool({
		name: 'run_demo',
		description: 'Run the demo background job: logs progress and returns a structured receipt.',
		input: v.object({ requestedAt: v.string() }),
		async run({ data, log }) {
			log.info('demo job started', { requestedAt: data.requestedAt });
			writeJobCardData({ status: 'running', step: 'starting' });
			await new Promise((resolve) => setTimeout(resolve, 500));
			log.info('demo job received data', { data });
			writeJobCardData({ status: 'running', step: 'processing input' });
			await new Promise((resolve) => setTimeout(resolve, 500));
			log.info('demo job completed');
			writeJobCardData({ status: 'done', step: 'finished' });
			return { ok: true, requestedAt: data.requestedAt };
		},
	});
	return 'When asked to run the demo, call the run_demo tool and report its result.';
}
