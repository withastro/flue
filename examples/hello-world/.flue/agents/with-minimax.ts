import type { FlueContext } from '@flue/sdk/client';
import * as v from 'valibot';

export const triggers = { webhook: true };

/**
 * MiniMax-M2.7 example.
 *
 * Demonstrates using MiniMax as the model provider via the `minimax` provider
 * key. MiniMax-M2.7 uses an Anthropic-compatible messages API and supports
 * extended thinking / reasoning.
 *
 * Set the `MINIMAX_API_KEY` environment variable, or pass the key at runtime:
 *
 *   await init({
 *     model: 'minimax/MiniMax-M2.7',
 *     providers: { minimax: { apiKey: env.MINIMAX_API_KEY } },
 *   });
 *
 * Both forms work — env var is the simpler path for local dev; `providers`
 * is the right approach for Cloudflare Workers where `env` bindings are
 * scoped to the request rather than available globally.
 *
 * Run with:
 *   flue run with-minimax --target node \
 *     --payload '{"text":"Hello, world!","language":"French"}'
 */
export default async function ({ init, payload, env }: FlueContext) {
	const agent = await init({
		model: 'minimax/MiniMax-M2.7',
		// Pass the API key explicitly so it works in environments where
		// MINIMAX_API_KEY cannot be set as a process-global env var (e.g. Cloudflare).
		// When MINIMAX_API_KEY is already set in the environment, the `providers`
		// block is optional — omitting it falls back to the env var automatically.
		providers: {
			minimax: {
				apiKey: env.MINIMAX_API_KEY,
			},
		},
	});
	const session = await agent.session();

	const result = await session.prompt(
		`Translate this to ${payload.language ?? 'French'}: "${payload.text ?? 'Hello, world!'}"`,
		{
			result: v.object({
				translation: v.string(),
				confidence: v.picklist(['low', 'medium', 'high']),
			}),
		},
	);

	console.log('[with-minimax] translation:', result.translation);
	console.log('[with-minimax] confidence:', result.confidence);
	return result;
}
