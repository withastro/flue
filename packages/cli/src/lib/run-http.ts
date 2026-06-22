export const DEFAULT_LOCAL_SERVER_ORIGIN = 'http://127.0.0.1:3583';

export function isAbsoluteServer(value: string | undefined): boolean {
	if (value === undefined) return false;
	try {
		const url = new URL(value);
		return url.protocol === 'http:' || url.protocol === 'https:';
	} catch {
		return false;
	}
}

export function parseHeaders(values: readonly string[]): Record<string, string> {
	const headers: Record<string, string> = {};
	const authoredNames = new Map<string, string>();
	for (const value of values) {
		const separator = value.indexOf(':');
		if (separator <= 0) throw new TypeError(`[flue] Invalid header: ${JSON.stringify(value)}.`);
		const name = value.slice(0, separator).trim();
		const headerValue = value.slice(separator + 1).trim();
		if (!name || !isHeaderName(name)) {
			throw new TypeError(`[flue] Invalid header name: ${JSON.stringify(name)}.`);
		}
		if (/[^\t\x20-\x7e\x80-\xff]/.test(headerValue)) {
			throw new TypeError(`[flue] Invalid value for header ${JSON.stringify(name)}.`);
		}
		const normalizedName = name.toLowerCase();
		const previousName = authoredNames.get(normalizedName);
		if (previousName !== undefined) delete headers[previousName];
		authoredNames.set(normalizedName, name);
		headers[name] = headerValue;
	}
	return headers;
}

export function resolveServerUrl(
	server: string | undefined,
	localOrigin = DEFAULT_LOCAL_SERVER_ORIGIN,
): string {
	const origin = absoluteHttpUrl(localOrigin, 'local origin');
	if (server === undefined) return origin.toString().replace(/\/$/, '');
	if (server.startsWith('/')) return joinMount(origin, server);
	return absoluteHttpUrl(server, '--server').toString().replace(/\/$/, '');
}

function joinMount(origin: URL, mount: string): string {
	if (!mount.startsWith('/')) {
		throw new TypeError(`[flue] Authored mount path must start with "/": ${JSON.stringify(mount)}.`);
	}
	const url = new URL(origin.origin);
	url.pathname = mount.replace(/\/+$/, '') || '/';
	return url.toString().replace(/\/$/, '');
}

function absoluteHttpUrl(value: string, label: string): URL {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new TypeError(`[flue] ${label} must be an absolute URL: ${JSON.stringify(value)}.`);
	}
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new TypeError(`[flue] ${label} must use http or https: ${JSON.stringify(value)}.`);
	}
	return url;
}

function isHeaderName(value: string): boolean {
	return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(value);
}
