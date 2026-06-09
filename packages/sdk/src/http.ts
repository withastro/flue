/** Static headers or a function that resolves headers for each HTTP request. */
export type RequestHeaders =
	| Record<string, string>
	| (() => Record<string, string> | Promise<Record<string, string>>);

export interface HttpClientOptions {
	/** URL where the public `flue()` sub-app is mounted, including any pathname. */
	baseUrl: string;
	/** Custom HTTP implementation. Defaults to the global `fetch`. */
	fetch?: typeof fetch;
	/** Headers merged into each HTTP request. */
	headers?: RequestHeaders;
	/** Bearer token added to HTTP requests. */
	token?: string;
}

export interface JsonRequestOptions {
	method?: string;
	path: string;
	query?: Record<string, string | number | boolean | undefined>;
	body?: unknown;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/** Failed SDK HTTP JSON request. */
export class FlueApiError extends Error {
	/** HTTP response status. */
	readonly status: number;
	/** Parsed response body when available; otherwise the response text. */
	readonly body: unknown;

	constructor(status: number, body: unknown) {
		super(errorMessage(status, body));
		this.name = 'FlueApiError';
		this.status = status;
		this.body = body;
	}
}

export class HttpClient {
	readonly baseUrl: string;
	readonly fetchImpl: typeof fetch;
	private headers: RequestHeaders | undefined;
	private token: string | undefined;

	constructor(options: HttpClientOptions) {
		this.baseUrl = options.baseUrl.replace(/\/+$/, '');
		this.fetchImpl = options.fetch ?? fetch;
		this.headers = options.headers;
		this.token = options.token;
	}

	async json<T>(options: JsonRequestOptions): Promise<T> {
		const response = await this.fetchImpl(this.url(options.path, options.query), {
			method: options.method ?? 'GET',
			headers: await this.requestHeaders(options.headers, options.body !== undefined),
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			signal: options.signal,
		});
		return parseJsonResponse<T>(response);
	}

	url(path: string, query?: Record<string, string | number | boolean | undefined>): string {
		const url = new URL(path.replace(/^\/+/, ''), `${this.baseUrl}/`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	/**
	 * Resolve auth/custom headers for a non-body request. Called per-request
	 * so that async header factories (e.g. token refresh) are re-evaluated.
	 * Used by the DS stream wrapper to inject headers on every reconnection.
	 */
	async resolveHeaders(): Promise<Record<string, string>> {
		const headers =
			typeof this.headers === 'function' ? await this.headers() : (this.headers ?? {});
		return {
			...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			...headers,
		};
	}

	async fetchWithHeaders(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
		const resolved = await this.resolveHeaders();
		const mergedHeaders = {
			...resolved,
			...(init?.headers as Record<string, string> | undefined),
		};
		return this.fetchImpl(input, { ...init, headers: mergedHeaders });
	}

	async requestHeaders(
		extra: Record<string, string> | undefined,
		hasBody: boolean,
	): Promise<Record<string, string>> {
		const base = await this.resolveHeaders();
		return {
			...(hasBody ? { 'content-type': 'application/json' } : {}),
			...base,
			...extra,
		};
	}
}

async function parseJsonResponse<T>(response: Response): Promise<T> {
	const text = await response.text();
	const body = text ? safeJsonParse(text) : undefined;
	if (!response.ok) throw new FlueApiError(response.status, text ? body : text);
	return body as T;
}

function safeJsonParse(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

function errorMessage(status: number, body: unknown): string {
	if (typeof body === 'object' && body !== null && 'error' in body) {
		const error = (body as { error?: { type?: string; message?: string } }).error;
		return `Flue API error ${status}${error?.type ? ` [${error.type}]` : ''}: ${error?.message ?? 'request failed'}`;
	}
	return `Flue API error ${status}: request failed`;
}
