/**
 * Helpers users can call from `flue.config.ts` to build pi-ai `Model`
 * instances without hand-authoring the full `Model` literal.
 *
 * Today there is one helper, for OpenAI-compatible endpoints
 * (`defineOpenAICompletionsModel`), because the built-in
 * `'openai-completions'` API in pi-ai already covers the long tail
 * (Ollama, vLLM, LM Studio, llama.cpp, LiteLLM, Together, OpenRouter, …).
 * Additional helpers for other pi-ai APIs can be added here as needed.
 */
import type { Model } from '@mariozechner/pi-ai';

/**
 * Options for {@link defineOpenAICompletionsModel}. Only `id`, `baseUrl`,
 * and `provider` are required; everything else has sensible defaults so
 * the common case stays a one-liner inside `flue.config.ts`.
 */
export interface DefineOpenAICompletionsModelOptions {
	/**
	 * Model identifier sent on the wire (e.g. `"llama3.1:8b"` for Ollama,
	 * `"gpt-4o-mini"` for an OpenAI-compatible gateway).
	 */
	id: string;

	/**
	 * Endpoint URL, including any version path (e.g.
	 * `"http://localhost:11434/v1"` for Ollama).
	 */
	baseUrl: string;

	/**
	 * Provider name surfaced on assistant messages, usage logs, and used as
	 * the lookup key for `init({ providers: { ... } })` overrides.
	 */
	provider: string;

	/**
	 * Display name. Defaults to `id` when omitted.
	 */
	name?: string;

	/**
	 * Whether the model exposes thinking/reasoning. Defaults to `false`.
	 * Set to `true` for reasoning-capable local models (e.g. DeepSeek-R1
	 * variants) so pi-ai forwards the configured thinking level.
	 */
	reasoning?: boolean;

	/**
	 * Input modalities the model accepts. Defaults to `['text']`.
	 */
	input?: ('text' | 'image')[];

	/**
	 * Per-token cost, in dollars per token. Defaults to all zeros — local
	 * endpoints have no per-token cost, and gateways can override at
	 * provider settings level if cost reporting matters.
	 */
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};

	/**
	 * Total context window in tokens. Defaults to 0 (unknown). Flue's
	 * compaction overflow detection degrades gracefully when 0 — it
	 * relies on this to size soft limits, so set it when the value is
	 * known.
	 */
	contextWindow?: number;

	/**
	 * Maximum response length in tokens. Defaults to 0 (provider default).
	 */
	maxTokens?: number;

	/**
	 * Static request headers merged into every call. Useful for static
	 * auth tokens or routing preferences. Per-request `providers` settings
	 * still override these.
	 */
	headers?: Record<string, string>;
}

/**
 * Build a pi-ai `Model<'openai-completions'>` from a small options object.
 * The returned value can be returned from a `models` factory in
 * `flue.config.ts`:
 *
 * ```ts
 * export default defineConfig({
 *   models: {
 *     'ollama/': (id) => defineOpenAICompletionsModel({
 *       id,
 *       baseUrl: 'http://localhost:11434/v1',
 *       provider: 'ollama',
 *     }),
 *   },
 * });
 * ```
 */
export function defineOpenAICompletionsModel(
	options: DefineOpenAICompletionsModelOptions,
): Model<'openai-completions'> {
	return {
		id: options.id,
		name: options.name ?? options.id,
		api: 'openai-completions',
		provider: options.provider,
		baseUrl: options.baseUrl,
		reasoning: options.reasoning ?? false,
		input: options.input ?? ['text'],
		cost: options.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: options.contextWindow ?? 0,
		maxTokens: options.maxTokens ?? 0,
		headers: options.headers,
	};
}
