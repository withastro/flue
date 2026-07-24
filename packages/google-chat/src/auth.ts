import {
	type CryptoKey,
	decodeProtectedHeader,
	importJWK,
	importX509,
	type JWTPayload,
	jwtVerify,
} from 'jose';

const GOOGLE_CHAT_IDENTITY = 'chat@system.gserviceaccount.com';
const GOOGLE_TOKEN_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'] as const;
const DEFAULT_GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_CHAT_CERTS_URL =
	'https://www.googleapis.com/service_accounts/v1/metadata/x509/chat%40system.gserviceaccount.com';
const DEFAULT_CACHE_MS = 60 * 60 * 1000;
const MAX_CACHE_MS = 24 * 60 * 60 * 1000;
const UNKNOWN_KEY_REFRESH_COOLDOWN_MS = 60 * 1000;
const MAX_DISCOVERY_BYTES = 1024 * 1024;

/**
 * A transient failure fetching or parsing Google's signing-key discovery
 * document (JWKS / x509 certificates) — distinct from a genuinely invalid or
 * forged token, so route handlers can map it to 503 instead of 401.
 */
export class GoogleSigningKeyDiscoveryError extends Error {}

export type GoogleChatInteractionAuthentication =
	| {
			/** Verifies Google OIDC tokens addressed to the exact configured app URL. */
			type: 'endpoint-url';
			/** Exact HTTPS endpoint URL configured for the Google Chat app. */
			audience: string;
			/** Google OIDC JWKS override for supported environments and local tests. */
			jwksUrl?: string;
	  }
	| {
			/** Verifies Google Chat service tokens addressed to a numeric project. */
			type: 'project-number';
			/** Numeric Google Cloud project number expected in the token audience. */
			projectNumber: string;
			/** Google Chat certificate endpoint override for local protocol tests. */
			certificatesUrl?: string;
	  };

export interface GoogleChatPubSubAuthentication {
	/** Exact Pub/Sub subscription resource expected in push bodies. */
	subscription: string;
	/** Expected OIDC audience configured on the push subscription. */
	audience: string;
	/** Expected service-account identity used for authenticated push. */
	serviceAccountEmail: string;
	/** Google OIDC JWKS override for supported environments and local tests. */
	jwksUrl?: string;
}

interface GoogleTokenVerifierOptions {
	fetch?: typeof globalThis.fetch;
}

interface CachedKeys {
	expiresAt: number;
	keys: Map<string, CryptoKey>;
}

function createSigningKeyCache(refresh: () => Promise<CachedKeys>) {
	let cache: CachedKeys | undefined;
	let pending: Promise<CachedKeys> | undefined;
	let lastRefreshAt = Number.NEGATIVE_INFINITY;

	return async (kid: string): Promise<CryptoKey | undefined> => {
		const now = Date.now();
		const freshCache = cache && cache.expiresAt > now ? cache : undefined;
		const key = freshCache?.keys.get(kid);
		if (key) return key;
		if (pending) return (await pending).keys.get(kid);
		if (now - lastRefreshAt < UNKNOWN_KEY_REFRESH_COOLDOWN_MS) return undefined;
		pending = refresh();
		try {
			cache = await pending;
			const refreshedKey = cache.keys.get(kid);
			if (freshCache || !refreshedKey) lastRefreshAt = Date.now();
			return refreshedKey;
		} catch (error) {
			lastRefreshAt = Date.now();
			throw error;
		} finally {
			pending = undefined;
		}
	};
}

export function createInteractionTokenVerifier(
	authentication: GoogleChatInteractionAuthentication,
	options: GoogleTokenVerifierOptions,
): (authorization: string | null) => Promise<JWTPayload> {
	if (authentication.type === 'endpoint-url') {
		const verify = createGoogleOidcVerifier({
			audience: authentication.audience,
			email: GOOGLE_CHAT_IDENTITY,
			jwksUrl: authentication.jwksUrl,
			fetch: options.fetch,
		});
		return verify;
	}

	const fetcher = options.fetch ?? globalThis.fetch;
	const certificatesUrl = authentication.certificatesUrl ?? DEFAULT_CHAT_CERTS_URL;
	const findKey = createSigningKeyCache(() => fetchX509Keys(fetcher, certificatesUrl));

	return async (authorization) => {
		const token = readBearerToken(authorization);
		const header = decodeProtectedHeader(token);
		if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
			throw new Error('Invalid Google Chat token header.');
		}
		const key = await findKey(header.kid);
		if (!key) throw new Error('Unknown Google Chat signing key.');
		const result = await jwtVerify(token, key, {
			algorithms: ['RS256'],
			issuer: GOOGLE_CHAT_IDENTITY,
			audience: authentication.projectNumber,
		});
		return result.payload;
	};
}

export function createPubSubTokenVerifier(
	authentication: GoogleChatPubSubAuthentication,
	options: GoogleTokenVerifierOptions,
): (authorization: string | null) => Promise<JWTPayload> {
	return createGoogleOidcVerifier({
		audience: authentication.audience,
		email: authentication.serviceAccountEmail,
		jwksUrl: authentication.jwksUrl,
		fetch: options.fetch,
	});
}

function createGoogleOidcVerifier(options: {
	audience: string;
	email: string;
	jwksUrl?: string;
	fetch?: typeof globalThis.fetch;
}): (authorization: string | null) => Promise<JWTPayload> {
	const fetcher = options.fetch ?? globalThis.fetch;
	const jwksUrl = options.jwksUrl ?? DEFAULT_GOOGLE_JWKS_URL;
	const findKey = createSigningKeyCache(() => fetchJwks(fetcher, jwksUrl));

	return async (authorization) => {
		const token = readBearerToken(authorization);
		const header = decodeProtectedHeader(token);
		if (header.alg !== 'RS256' || typeof header.kid !== 'string' || !header.kid) {
			throw new Error('Invalid Google token header.');
		}
		const key = await findKey(header.kid);
		if (!key) throw new Error('Unknown Google signing key.');
		const result = await jwtVerify(token, key, {
			algorithms: ['RS256'],
			issuer: [...GOOGLE_TOKEN_ISSUERS],
			audience: options.audience,
		});
		if (result.payload.email !== options.email || result.payload.email_verified !== true) {
			throw new Error('Unexpected Google token identity.');
		}
		return result.payload;
	};
}

async function fetchJwks(fetcher: typeof globalThis.fetch, url: string): Promise<CachedKeys> {
	const response = await fetchDiscoveryDocument(fetcher, url);
	if (!response.ok)
		throw new GoogleSigningKeyDiscoveryError('Google signing-key discovery failed.');
	const body = await readJsonResponse(response);
	if (!isRecord(body) || !Array.isArray(body.keys)) {
		throw new GoogleSigningKeyDiscoveryError('Invalid Google JWKS response.');
	}
	const keys = new Map<string, CryptoKey>();
	for (const value of body.keys) {
		if (
			!isRecord(value) ||
			typeof value.kid !== 'string' ||
			value.kty !== 'RSA' ||
			value.alg !== 'RS256' ||
			value.use !== 'sig'
		) {
			continue;
		}
		try {
			const key = await importJWK(value, 'RS256');
			if (key instanceof Uint8Array) continue;
			keys.set(value.kid, key);
		} catch {}
	}
	if (keys.size === 0)
		throw new GoogleSigningKeyDiscoveryError('Google JWKS contained no usable keys.');
	return { keys, expiresAt: Date.now() + cacheDuration(response.headers) };
}

async function fetchX509Keys(fetcher: typeof globalThis.fetch, url: string): Promise<CachedKeys> {
	const response = await fetchDiscoveryDocument(fetcher, url);
	if (!response.ok)
		throw new GoogleSigningKeyDiscoveryError('Google Chat certificate discovery failed.');
	const body = await readJsonResponse(response);
	if (!isRecord(body)) {
		throw new GoogleSigningKeyDiscoveryError('Invalid Google Chat certificate response.');
	}
	const keys = new Map<string, CryptoKey>();
	for (const [id, certificate] of Object.entries(body)) {
		if (typeof certificate !== 'string') continue;
		try {
			keys.set(id, await importX509(certificate, 'RS256'));
		} catch {}
	}
	if (keys.size === 0) {
		throw new GoogleSigningKeyDiscoveryError(
			'Google Chat certificate response contained no usable keys.',
		);
	}
	return { keys, expiresAt: Date.now() + cacheDuration(response.headers) };
}

async function fetchDiscoveryDocument(
	fetcher: typeof globalThis.fetch,
	url: string,
): Promise<Response> {
	try {
		return await fetcher(url, { headers: { accept: 'application/json' } });
	} catch (error) {
		throw new GoogleSigningKeyDiscoveryError('Google signing-key discovery failed.', {
			cause: error,
		});
	}
}

function readBearerToken(authorization: string | null): string {
	if (!authorization?.startsWith('Bearer ')) throw new Error('Missing bearer token.');
	const token = authorization.slice('Bearer '.length);
	if (!token || token.includes(' ')) throw new Error('Invalid bearer token.');
	return token;
}

async function readJsonResponse(response: Response): Promise<unknown> {
	const contentLength = response.headers.get('content-length');
	if (contentLength && Number(contentLength) > MAX_DISCOVERY_BYTES) {
		throw new GoogleSigningKeyDiscoveryError('Google discovery response is too large.');
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (bytes.byteLength > MAX_DISCOVERY_BYTES) {
		throw new GoogleSigningKeyDiscoveryError('Google discovery response is too large.');
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		throw new GoogleSigningKeyDiscoveryError('Invalid Google discovery JSON.');
	}
}

function cacheDuration(headers: Headers): number {
	const cacheControl = headers.get('cache-control');
	const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i);
	if (!match) return DEFAULT_CACHE_MS;
	const seconds = Number(match[1]);
	return Number.isSafeInteger(seconds)
		? Math.min(Math.max(60_000, seconds * 1000), MAX_CACHE_MS)
		: DEFAULT_CACHE_MS;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
