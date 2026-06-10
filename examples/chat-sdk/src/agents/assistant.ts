import {
	fauxAssistantMessage,
	fauxText,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { createAgent, defineTool, Type } from '@flue/runtime';

type Env = {
	CHAT_INGRESS: DurableObjectNamespace;
};

const faux = registerFauxProvider({
	api: 'chat-sdk-example',
	provider: 'chat-sdk-example',
	models: [{ id: 'assistant' }],
});
faux.setResponses(Array.from({ length: 100 }, () => responseForContext));

export default createAgent<unknown, Env>(({ env }) => {
	return {
		model: 'chat-sdk-example/assistant',
		instructions:
			'When receiving a chat message, ask for approval if it is not approved yet. When the user approves, reply in the supplied thread.',
		tools: [
			defineTool({
				name: 'reply_to_chat_thread',
				description: 'Post a response into the originating Chat SDK thread.',
				parameters: Type.Object({
					threadId: Type.String(),
					text: Type.String(),
				}),
				execute: async ({ threadId, text }) => {
					await getChatIngress(env.CHAT_INGRESS).fetch(
						new Request('https://chat-ingress.local/deliver', {
							body: JSON.stringify({ text, threadId }),
							headers: { 'Content-Type': 'application/json' },
							method: 'POST',
						}),
					);
					return 'Reply sent.';
				},
			}),
		],
	};
});

function responseForContext(context: { messages: Array<{ content: unknown; role: string }> }) {
	const text = lastUserText(context.messages);
	if (text === '') {
		return fauxAssistantMessage(fauxText('Reply sent.'));
	}
	const threadId = /"threadId"\s*:\s*"([^"]+)"/.exec(text)?.[1] ?? '';
	const approved = /"text"\s*:\s*"[^"]*approve/i.test(text);
	return fauxAssistantMessage(
		fauxToolCall('reply_to_chat_thread', {
			threadId,
			text: approved
				? 'Approved by a human. Reply from a Flue agent through Chat SDK.'
				: 'I need human approval before continuing. Reply with "approve" in this thread.',
		}),
		{ stopReason: 'toolUse' },
	);
}

function getChatIngress(namespace: DurableObjectNamespace): DurableObjectStub {
	return namespace.get(namespace.idFromName('default'));
}

function lastUserText(messages: Array<{ content: unknown; role: string }>): string {
	const input = messages.at(-1);
	if (input?.role !== 'user') {
		return '';
	}
	return typeof input.content === 'string'
		? input.content
		: Array.isArray(input.content)
			? input.content
					.map((block) =>
						block && typeof block === 'object' && (block as { type?: unknown }).type === 'text'
							? ((block as { text?: string }).text ?? '')
							: '',
					)
					.join('')
			: '';
}
