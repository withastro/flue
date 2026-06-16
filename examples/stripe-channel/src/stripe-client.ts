import Stripe from 'stripe';

export function stripeRequestOptions(accountId?: string, context?: string): Stripe.RequestOptions {
	if (context) return { stripeContext: context };
	if (accountId) return { stripeAccount: accountId };
	return {};
}

export function createStripeClient(
	secretKey: string,
	fetcher: typeof globalThis.fetch = globalThis.fetch,
): Stripe {
	return new Stripe(secretKey, {
		httpClient: Stripe.createFetchHttpClient(fetcher),
	});
}
