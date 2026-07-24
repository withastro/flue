'use agent';
import { createProvider } from '@earendil-works/pi-ai';
import { openAICompletionsApi } from '@earendil-works/pi-ai/api/openai-completions.lazy';
import { setProvider, useModel, useTool } from '@flue/runtime';

// Custom providers for local OpenAI-compatible servers register at module
// scope, so the agent works the same under `vite dev` and
// `flue run src/agents/with-registered-provider.ts`.
setProvider(
	createProvider({
		id: 'ollama',
		// Keyless local server: auth resolves to nothing.
		auth: { apiKey: { name: 'Ollama (keyless)', resolve: async () => ({ auth: {} }) } },
		models: [
			{
				id: 'llama3.1:8b',
				name: 'Llama 3.1 8B (local)',
				api: 'openai-completions',
				provider: 'ollama',
				baseUrl: 'http://localhost:11434/v1',
				reasoning: false,
				input: ['text'],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128000,
				maxTokens: 8192,
			},
		],
		api: openAICompletionsApi(),
	}),
);

export function WithRegisteredProvider() {
	useModel('ollama/llama3.1:8b');
	useTool({
		name: 'provider-smoke',
		description: 'Verify a prompt can be run against the registered provider.',
		harness: true,
		async run({ harness }) {
			const response = await harness.prompt('Reply with exactly one word: ok');
			return { ok: true, hasResponse: response.text.length > 0 };
		},
	});
	return 'When asked to run a demo, call the `provider-smoke` tool and report its result.';
}
