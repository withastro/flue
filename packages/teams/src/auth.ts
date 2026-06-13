import { decodeProtectedHeader, importJWK, jwtVerify, type JWK } from 'jose';

const DEFAULT_OPEN_ID_METADATA_URL =
	'https://login.botframework.com/v1/.well-known/openidconfiguration';
const DEFAULT_TOKEN_ISSUER = 'https://api.botframework.com';
const DEFAULT_CACHE_TTL_MS = 60 * 60 * 1000;
const MAX_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_DISCOVERY_BODY_BYTES = 4 * 1024 * 1024;
const UNKNOWN_KID_REFRESH_COOLDOWN_MS = 30_000;

interface BotFrameworkSigningKey extends JWK {
	kid: string;
	endorsements: readonly string[];
}

interface CachedKeySet {
	expiresAt: number;
	keys: readonly BotFrameworkSigningKey[];
}

export interface BotFrameworkTokenVerifierOptions {
	appId: string;
	openIdMetadataUrl?: string;
	tokenIssuer?: string;
	fetch?: typeof globalThis.fetch;
}

export interface VerifiedBotFrameworkToken {
	serviceUrl: string;
	endorsements: readonly string[];
}

export class BotFrameworkDiscoveryError extends Error {
	constructor() {
		super('Microsoft Bot Framework signing keys are unavailable.');
		this.name = 'BotFrameworkDiscoveryError';
	}
}

export function createBotFrameworkTokenVerifier(options: BotFrameworkTokenVerifierOptions) {
	const fetcher = options.fetch ?? globalThis.fetch;
	const metadataUrl = options.openIdMetadataUrl ?? DEFAULT_OPEN_ID_METADATA_URL;
	const tokenIssuer = options.tokenIssuer ?? DEFAULT_TOKEN_ISSUER;
	let cache: CachedKeySet | undefined;
	let pending: Promise<CachedKeySet> | undefined;
	let lastUnknownKidRefreshAt = Number.NEGATIVE_INFINITY;
	const importedKeys = new Map<string, CryptoKey>();

	return async (authorization: string | null): Promise<VerifiedBotFrameworkToken> => {
		const token = parseBearerToken(authorization);
		if (!token) throw new TypeError('Invalid authorization.');

		let protectedHeader: ReturnType<typeof decodeProtectedHeader>;
		try {
			protectedHeader = decodeProtectedHeader(token);
		} catch {
			throw new TypeError('Invalid authorization.');
		}
		if (
			protectedHeader.alg !== 'RS256' ||
			typeof protectedHeader.kid !== 'string' ||
			protectedHeader.kid.length === 0
		) {
			throw new TypeError('Invalid authorization.');
		}

		let signingKey = await findSigningKey(protectedHeader.kid, false);
		if (!signingKey) signingKey = await findSigningKey(protectedHeader.kid, true);
		if (!signingKey) throw new TypeError('Invalid authorization.');

		try {
			let key = importedKeys.get(signingKey.kid);
			if (!key) {
				const imported = await importJWK(signingKey, 'RS256');
				if (!(imported instanceof CryptoKey)) throw new TypeError('Invalid authorization.');
				key = imported;
				importedKeys.set(signingKey.kid, key);
			}
			const { payload } = await jwtVerify(token, key, {
				algorithms: ['RS256'],
				audience: options.appId,
				issuer: tokenIssuer,
				requiredClaims: ['exp', 'serviceurl'],
				clockTolerance: 5,
			});
			if (typeof payload.serviceurl !== 'string' || payload.serviceurl.length === 0) {
				throw new TypeError('Invalid authorization.');
			}
			return {
				serviceUrl: payload.serviceurl,
				endorsements: signingKey.endorsements,
			};
		} catch {
			throw new TypeError('Invalid authorization.');
		}
	};

	async function findSigningKey(
		kid: string,
		forceRefresh: boolean,
	): Promise<BotFrameworkSigningKey | undefined> {
		const keySet = await loadKeySet(forceRefresh);
		return keySet.keys.find((key) => key.kid === kid);
	}

	async function loadKeySet(forceRefresh: boolean): Promise<CachedKeySet> {
		const now = Date.now();
		if (!forceRefresh && cache && cache.expiresAt > now) return cache;
		if (forceRefresh && cache && now - lastUnknownKidRefreshAt < UNKNOWN_KID_REFRESH_COOLDOWN_MS) {
			return cache;
		}
		if (pending) return pending;

		pending = fetchKeySet();
		try {
			cache = await pending;
			importedKeys.clear();
			if (forceRefresh) lastUnknownKidRefreshAt = Date.now();
			return cache;
		} finally {
			pending = undefined;
		}
	}

	async function fetchKeySet(): Promise<CachedKeySet> {
		try {
			const metadataResponse = await fetcher(metadataUrl, {
				headers: { accept: 'application/json' },
			});
			if (!metadataResponse.ok) throw new BotFrameworkDiscoveryError();
			const metadata = await readJsonObject(metadataResponse);
			if (metadata.issuer !== tokenIssuer || typeof metadata.jwks_uri !== 'string') {
				throw new BotFrameworkDiscoveryError();
			}
			assertHttpsUrl(metadata.jwks_uri);

			const keyResponse = await fetcher(metadata.jwks_uri, {
				headers: { accept: 'application/json' },
			});
			if (!keyResponse.ok) throw new BotFrameworkDiscoveryError();
			const rawKeySet = await readJsonObject(keyResponse);
			if (!Array.isArray(rawKeySet.keys)) throw new BotFrameworkDiscoveryError();
			const keys = rawKeySet.keys
				.map(normalizeSigningKey)
				.filter((key): key is BotFrameworkSigningKey => key !== undefined);
			if (keys.length === 0) throw new BotFrameworkDiscoveryError();

			const ttl = Math.min(
				cacheTtl(metadataResponse.headers.get('cache-control')),
				cacheTtl(keyResponse.headers.get('cache-control')),
			);
			return { keys, expiresAt: Date.now() + ttl };
		} catch (error) {
			if (error instanceof BotFrameworkDiscoveryError) throw error;
			throw new BotFrameworkDiscoveryError();
		}
	}
}

export function defaultBotFrameworkOpenIdMetadataUrl(): string {
	return DEFAULT_OPEN_ID_METADATA_URL;
}

export function defaultBotFrameworkTokenIssuer(): string {
	return DEFAULT_TOKEN_ISSUER;
}

function normalizeSigningKey(value: unknown): BotFrameworkSigningKey | undefined {
	if (!isRecord(value)) return undefined;
	if (
		typeof value.kid !== 'string' ||
		value.kid.length === 0 ||
		value.kty !== 'RSA' ||
		typeof value.n !== 'string' ||
		typeof value.e !== 'string' ||
		!Array.isArray(value.endorsements) ||
		!value.endorsements.every((endorsement) => typeof endorsement === 'string')
	) {
		return undefined;
	}
	return {
		...value,
		kid: value.kid,
		kty: 'RSA',
		n: value.n,
		e: value.e,
		endorsements: value.endorsements,
	};
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
	const contentLength = response.headers.get('content-length');
	if (
		contentLength !== null &&
		(!/^\d+$/.test(contentLength) || Number(contentLength) > MAX_DISCOVERY_BODY_BYTES)
	) {
		throw new BotFrameworkDiscoveryError();
	}
	const text = await response.text();
	if (new TextEncoder().encode(text).byteLength > MAX_DISCOVERY_BODY_BYTES) {
		throw new BotFrameworkDiscoveryError();
	}
	const value: unknown = JSON.parse(text);
	if (!isRecord(value)) throw new BotFrameworkDiscoveryError();
	return value;
}

function cacheTtl(cacheControl: string | null): number {
	const match = cacheControl?.match(/(?:^|,)\s*max-age=(\d+)/i);
	if (!match?.[1]) return DEFAULT_CACHE_TTL_MS;
	const seconds = Number(match[1]);
	if (!Number.isSafeInteger(seconds) || seconds < 0) return DEFAULT_CACHE_TTL_MS;
	return Math.min(seconds * 1000, MAX_CACHE_TTL_MS);
}

function parseBearerToken(value: string | null): string | undefined {
	if (!value) return undefined;
	const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(value);
	return match?.[1];
}

function assertHttpsUrl(value: string): void {
	const url = new URL(value);
	if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') {
		throw new BotFrameworkDiscoveryError();
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
