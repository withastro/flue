import type { FlueContext } from '@flue/sdk';

export const triggers = { webhook: true };

/**
 * Demonstrates the request metadata exposed on `FlueContext`.
 *
 * `ctx.req` is the standard Fetch `Request` for the current invocation. Read
 * headers, method, URL, and the raw body — useful for HMAC signature
 * verification (Stripe, GitHub, etc.) over the request bytes.
 *
 * `ctx.req` is `undefined` when the agent is invoked outside an HTTP context
 * (e.g. future cron / queue triggers). Today every trigger is HTTP, so in
 * practice it's always defined.
 */
export default async function ({ req, init }: FlueContext) {
	console.log('[with-request] method:', req?.method);
	console.log('[with-request] url:', req?.url);
	console.log('[with-request] user-agent:', req?.headers.get('user-agent'));

	// The raw body is also available — useful for things like HMAC
	// signature verification (Stripe, GitHub, etc.) over the request bytes.
	const rawBody = await req?.text();
	console.log('[with-request] raw body:', rawBody);

	// Client IP: parse from the platform's header. On Cloudflare,
	// `cf-connecting-ip` is set by the platform and safe to trust. On Node
	// behind a trusted proxy, parse `x-forwarded-for`. Don't trust headers
	// from clients you don't control.
	const ip =
		req?.headers.get('cf-connecting-ip') ??
		req?.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
	console.log('[with-request] ip:', ip);

	// Light-touch authorization check. Real auth schemes (bearer tokens, HMAC,
	// platform-issued JWTs) verify the header against a secret in `ctx.env`.
	// Here we just demo reading the header and returning early when absent.
	const authHeader = req?.headers.get('authorization');
	if (!authHeader) {
		console.log('[with-request] no authorization header — skipping LLM call');
		return { skipped: true, reason: 'no authorization header' };
	}

	console.log('[with-request] authorization header present, proceeding');
	const agent = await init({ model: 'anthropic/claude-haiku-4-5' });
	const session = await agent.session();
	const response = await session.prompt('Say hello in 5 words.');
	return { skipped: false, text: response.text };
}
