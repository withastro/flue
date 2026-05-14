/**
 * Cloudflare AI Gateway options forwarded as the third argument to
 * `env.AI.run(...)`. Mirrors the shape documented at
 * https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/.
 *
 * Carried on a `CloudflareAIBindingRegistration` from `app.ts`; the binding
 * provider attaches it to every `env.AI.run(...)` call routed through that
 * registration.
 */
export interface CloudflareGatewayOptions {
	/**
	 * The AI Gateway id (slug) to route requests through. Required when
	 * gateway options are specified.
	 */
	id: string;
	/** Bypass the gateway cache for this request. */
	skipCache?: boolean;
	/** Override the cache TTL (seconds) for this request. */
	cacheTtl?: number;
	/** Override the cache key used for this request. */
	cacheKey?: string;
	/**
	 * Arbitrary metadata associated with the request. Surfaced on the
	 * Gateway log entry.
	 */
	metadata?: Record<string, number | string | boolean | null | bigint>;
	/** Force collecting (or not collecting) request logs on the Gateway. */
	collectLog?: boolean;
	/** Correlate this request with a custom event id on the Gateway log. */
	eventId?: string;
	/** Per-request timeout enforced by the Gateway, in milliseconds. */
	requestTimeoutMs?: number;
}
