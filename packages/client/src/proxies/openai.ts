import type { ProxyFactory, ProxyPolicy, ProxyService } from './types.ts';

/**
 * OpenAI model provider proxy preset.
 *
 * Returns a ProxyFactory that, when called with `{ apiKey }`, produces a
 * ProxyService proxying requests to api.openai.com with the API key
 * injected. Strips all non-allowlisted headers for security.
 */
export function openai(opts?: {
	policy?: string | ProxyPolicy;
}): ProxyFactory<{ apiKey: string }> {
	const factory = (secrets: { apiKey: string }): ProxyService => {
		const { apiKey } = secrets;
		return {
			name: 'openai',
			target: 'https://api.openai.com',
			headers: {
				authorization: `Bearer ${apiKey}`,
				host: 'api.openai.com',
			},
			transform: (req) => {
				const safe = [
					'content-type',
					'content-length',
					'accept',
					'user-agent',
					'openai-organization',
					'openai-project',
				];
				const filtered: Record<string, string> = {};
				for (const key of safe) {
					if (req.headers[key]) filtered[key] = req.headers[key];
				}
				filtered.authorization = `Bearer ${apiKey}`;
				return { headers: filtered };
			},
			policy: opts?.policy ?? 'allow-all',
			isModelProvider: true,
			providerConfig: {
				providerKey: 'openai',
				options: {
					apiKey: 'sk-dummy-value-real-key-injected-by-proxy',
				},
			},
		};
	};

	factory.secretsMap = { apiKey: 'OPENAI_API_KEY' } as const;
	factory.proxyName = 'openai';
	return factory;
}
