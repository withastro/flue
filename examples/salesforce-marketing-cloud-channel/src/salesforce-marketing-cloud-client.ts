export interface SalesforceMarketingCloudClientOptions {
	restBaseUrl: string;
	accessToken: string;
	fetcher?: typeof globalThis.fetch;
}

interface SalesforceMarketingCloudCallback {
	callbackId: string;
	callbackName: string;
	url: string;
	maxBatchSize: number;
	status: string;
	statusReason: string;
}

export interface SalesforceMarketingCloudClient {
	getCallback(callbackId: string): Promise<SalesforceMarketingCloudCallback>;
}

export function createSalesforceMarketingCloudClient({
	restBaseUrl,
	accessToken,
	fetcher = globalThis.fetch,
}: SalesforceMarketingCloudClientOptions): SalesforceMarketingCloudClient {
	const origin = salesforceMarketingCloudRestOrigin(restBaseUrl);
	if (!accessToken || accessToken.trim() !== accessToken) {
		throw new TypeError('Salesforce Marketing Cloud access token must be non-empty and trimmed.');
	}
	if (typeof fetcher !== 'function') {
		throw new TypeError('Salesforce Marketing Cloud Fetch must be callable.');
	}

	return {
		async getCallback(callbackId) {
			validateCallbackId(callbackId);
			const response = await fetcher(
				`${origin}/platform/v1/ens-callbacks/${encodeURIComponent(callbackId)}`,
				{
					method: 'GET',
					headers: {
						accept: 'application/json',
						authorization: `Bearer ${accessToken}`,
					},
				},
			);

			if (!response.ok) {
				throw new Error(
					`Salesforce Marketing Cloud request failed with status ${response.status}.`,
				);
			}

			let value: unknown;
			try {
				value = await response.json();
			} catch {
				throw new TypeError('Salesforce Marketing Cloud returned invalid JSON.');
			}
			if (!isCallback(value) || value.callbackId !== callbackId) {
				throw new TypeError('Salesforce Marketing Cloud returned an invalid callback response.');
			}
			return value;
		},
	};
}

function salesforceMarketingCloudRestOrigin(restBaseUrl: string): string {
	let url: URL;
	try {
		url = new URL(restBaseUrl);
	} catch {
		throw new TypeError('Salesforce Marketing Cloud REST base URL must be a valid URL.');
	}

	const suffix = '.rest.marketingcloudapis.com';
	if (
		url.protocol !== 'https:' ||
		url.username !== '' ||
		url.password !== '' ||
		url.port !== '' ||
		url.search !== '' ||
		url.hash !== '' ||
		url.pathname !== '/' ||
		!url.hostname.endsWith(suffix) ||
		url.hostname.length === suffix.length ||
		!isDnsName(url.hostname)
	) {
		throw new TypeError(
			'Salesforce Marketing Cloud REST base URL must be an HTTPS tenant origin ending in .rest.marketingcloudapis.com.',
		);
	}

	return url.origin;
}

function validateCallbackId(callbackId: string): void {
	if (!callbackId || callbackId.trim() !== callbackId) {
		throw new TypeError('Salesforce Marketing Cloud callback id must be non-empty and trimmed.');
	}
}

function isCallback(value: unknown): value is SalesforceMarketingCloudCallback {
	return (
		isRecord(value) &&
		isNonEmptyString(value.callbackId) &&
		isNonEmptyString(value.callbackName) &&
		isNonEmptyString(value.url) &&
		Number.isSafeInteger(value.maxBatchSize) &&
		(value.maxBatchSize as number) > 0 &&
		isNonEmptyString(value.status) &&
		isNonEmptyString(value.statusReason)
	);
}

function isDnsName(hostname: string): boolean {
	return hostname
		.split('.')
		.every(
			(label) =>
				label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label),
		);
}

function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
