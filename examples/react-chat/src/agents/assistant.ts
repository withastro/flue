'use agent';
import { fauxAssistantMessage, fauxProvider, fauxText } from '@earendil-works/pi-ai';
import { setProvider, useModel } from '@flue/runtime';

// The 'use agent' directive registers this module's exported agent functions
// with the app (the function name is the durable identity); app.ts exposes
// this one over HTTP by mounting `createAgentRouter(Assistant)` at
// `/api/agents/assistant`. Middleware (e.g. auth) composes in app.ts with
// plain Hono, before the mount it applies to.

// The scripted (faux, keyless) model this offline example runs against.
// Module scope, not the agent body: the agent function is a render that may
// re-run, so one-time setup lives outside it.
const faux = fauxProvider({
	api: 'react-chat-example',
	provider: 'react-chat-example',
	models: [{ id: 'assistant' }],
});
setProvider(faux.provider);
// Faux responses are consumed one per model call, so the echo re-queues
// itself: one scripted reply per user message, indefinitely.
const echo: Parameters<typeof faux.setResponses>[0][number] = (context) => {
	faux.appendResponses([echo]);
	const input = context.messages.at(-1);
	const text =
		input?.role === 'user'
			? typeof input.content === 'string'
				? input.content
				: input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
			: '';
	return fauxAssistantMessage(fauxText(`You said: ${text}`));
};
faux.setResponses([echo]);

export function Assistant() {
	useModel('react-chat-example/assistant');
	return 'Reply briefly and helpfully.';
}
