/**
 * Example flue.config.ts.
 *
 * Demonstrates:
 *   1. Project-level `target` so `flue build`/`flue dev` work without
 *      `--target` on the command line.
 *   2. The `models` declarative map: register a custom prefix
 *      (here `"ollama/"`) so `init({ model: "ollama/llama3.1:8b" })`
 *      resolves to a local Ollama endpoint without touching the pi-ai
 *      catalog. The same pattern works for vLLM, LM Studio, llama.cpp,
 *      LiteLLM, OpenRouter, or any OpenAI-compatible endpoint.
 *
 * Most projects won't need `setup()` — pi-ai's built-in `openai-completions`
 * provider is registered automatically by Flue, and `defineOpenAICompletionsModel`
 * is enough to hook a custom endpoint up to it.
 */
import { defineConfig, defineOpenAICompletionsModel } from '@flue/sdk';

export default defineConfig({
	target: 'node',

	models: {
		'ollama/': (id) =>
			defineOpenAICompletionsModel({
				id,
				baseUrl: 'http://localhost:11434/v1',
				provider: 'ollama',
				// Ollama models live behind a local socket and have no per-token
				// cost; the catalog defaults to zeros so we leave them unset.
			}),
	},
});
