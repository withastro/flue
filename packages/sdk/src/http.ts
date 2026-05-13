export type RequestHeaders = Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);

export interface HttpClientOptions {
	baseUrl: string;
	fetch?: typeof fetch;
	headers?: RequestHeaders;
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

export class FlueApiError extends Error {
	readonly status: number;
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
		const url = new URL(path, `${this.baseUrl}/`);
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined) url.searchParams.set(key, String(value));
		}
		return url.toString();
	}

	async requestHeaders(extra: Record<string, string> | undefined, hasBody: boolean): Promise<Record<string, string>> {
		const headers = typeof this.headers === 'function' ? await this.headers() : (this.headers ?? {});
		return {
			...(hasBody ? { 'content-type': 'application/json' } : {}),
			...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
			...headers,
			...extra,
		};
	}
}

export async function parseJsonResponse<T>(response: Response): Promise<T> {
	const text = await response.text();
	const body = text ? safeJsonParse(text) : undefined;
	if (!response.ok) throw new FlueApiError(response.status, body ?? text);
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
