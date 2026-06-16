import { fauxAssistantMessage, fauxText, registerFauxProvider } from '@earendil-works/pi-ai';
import { createAgent } from '@flue/runtime';

export default createAgent(() => {
	const faux = registerFauxProvider({
		api: 'react-chat-example',
		provider: 'react-chat-example',
		models: [{ id: 'assistant' }],
	});
	faux.setResponses([
		(context) => {
			const input = context.messages.at(-1);
			const text =
				input?.role === 'user'
					? typeof input.content === 'string'
						? input.content
						: input.content.map((block) => (block.type === 'text' ? block.text : '')).join('')
					: '';
			return fauxAssistantMessage(fauxText(`You said: ${text}`));
		},
	]);
	return {
		model: 'react-chat-example/assistant',
		instructions: 'Reply briefly and helpfully.',
	};
});
