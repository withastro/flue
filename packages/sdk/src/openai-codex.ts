import { refreshOpenAICodexToken } from '@mariozechner/pi-ai/oauth';
import * as v from 'valibot';
import type { SessionEnv } from './types.ts';

export const OPENAI_CODEX_PROVIDER = 'openai-codex';
export const OPENAI_CODEX_AUTH_PATH = './.flue/auth/openai-codex.json';

const OPENAI_CODEX_AUTH_DIR = './.flue/auth';
const OPENAI_CODEX_AUTH_ENV = 'FLUE_OPENAI_CODEX_AUTH_JSON';
const OPENAI_CODEX_ACCESS_TOKEN_ENV = 'FLUE_OPENAI_CODEX_AUTH_ACCESS_TOKEN';
const OPENAI_CODEX_REFRESH_TOKEN_ENV = 'FLUE_OPENAI_CODEX_AUTH_REFRESH_TOKEN';
const OPENAI_CODEX_ACCOUNT_ID_ENV = 'FLUE_OPENAI_CODEX_AUTH_ACCOUNT_ID';
const OPENAI_CODEX_REFRESH_SKEW_MS = 60 * 1000;

const openAICodexFlatAuthSchema = v.object({
	access_token: v.string(),
	refresh_token: v.string(),
	account_id: v.string(),
	expires_at: v.number(),
	last_refresh: v.string(),
});

export type OpenAICodexAuth = v.InferOutput<typeof openAICodexFlatAuthSchema>;

const openAICodexBootstrapAuthSchema = v.object({
	auth_mode: v.optional(v.string()),
	OPENAI_API_KEY: v.optional(v.nullable(v.string())),
	tokens: v.optional(
		v.object({
			id_token: v.optional(v.string()),
			access_token: v.string(),
			refresh_token: v.string(),
			account_id: v.string(),
		}),
	),
	last_refresh: v.optional(v.string()),
});

export async function openAICodexLoadAuth(env: SessionEnv): Promise<OpenAICodexAuth | undefined> {
	const fileAuth = await openAICodexReadAuthFile(env);
	if (fileAuth) return fileAuth;

	const bootstrapAuth = openAICodexLoadBootstrapAuthFromEnv();
	if (bootstrapAuth) return bootstrapAuth;

	return openAICodexLoadAuthFromSeparateEnv();
}

export async function openAICodexRefreshAuth(auth: OpenAICodexAuth): Promise<OpenAICodexAuth> {
	if (!openAICodexShouldRefreshAuth(auth)) return auth;

	const refreshed = await refreshOpenAICodexToken(auth.refresh_token);
	return {
		...auth,
		access_token: refreshed.access,
		refresh_token: refreshed.refresh,
		account_id: openAICodexGetAccountId(refreshed.access) ?? auth.account_id,
		expires_at: refreshed.expires,
		last_refresh: new Date().toISOString(),
	};
}

export async function openAICodexSaveAuth(env: SessionEnv, auth: OpenAICodexAuth): Promise<void> {
	await env.mkdir(OPENAI_CODEX_AUTH_DIR, { recursive: true });
	await env.writeFile(OPENAI_CODEX_AUTH_PATH, JSON.stringify(auth, null, 2));
}

export function openAICodexProtectAuthPath(env: SessionEnv): SessionEnv {
	const authPath = env.resolvePath(OPENAI_CODEX_AUTH_PATH);
	const isAuthPath = (path: string) => env.resolvePath(path) === authPath;
	const deny = () => {
		throw new Error('[flue] Access denied');
	};

	return {
		...env,
		async readFile(path) {
			if (isAuthPath(path)) deny();
			return env.readFile(path);
		},
		async readFileBuffer(path) {
			if (isAuthPath(path)) deny();
			return env.readFileBuffer(path);
		},
		async writeFile(path, content) {
			if (isAuthPath(path)) deny();
			return env.writeFile(path, content);
		},
		async stat(path) {
			if (isAuthPath(path)) deny();
			return env.stat(path);
		},
		async exists(path) {
			if (isAuthPath(path)) return false;
			return env.exists(path);
		},
		async rm(path, options) {
			if (isAuthPath(path)) deny();
			return env.rm(path, options);
		},
		async scope(options) {
			const scoped = env.scope ? await env.scope(options) : env;
			return openAICodexProtectAuthPath(scoped);
		},
	};
}

async function openAICodexReadAuthFile(env: SessionEnv): Promise<OpenAICodexAuth | undefined> {
	try {
		const raw = await env.readFile(OPENAI_CODEX_AUTH_PATH);
		return openAICodexParseFlatAuth(raw);
	} catch {
		return undefined;
	}
}

function openAICodexLoadBootstrapAuthFromEnv(): OpenAICodexAuth | undefined {
	const raw = process.env[OPENAI_CODEX_AUTH_ENV];
	if (!raw) return undefined;
	try {
		const parsed = v.parse(openAICodexBootstrapAuthSchema, JSON.parse(raw));
		if (!parsed.tokens) return undefined;
		const expiresAt = openAICodexGetJwtExpiryMs(parsed.tokens.access_token);
		if (expiresAt === undefined) return undefined;

		return {
			access_token: parsed.tokens.access_token,
			refresh_token: parsed.tokens.refresh_token,
			account_id: parsed.tokens.account_id,
			expires_at: expiresAt,
			last_refresh: parsed.last_refresh ?? new Date().toISOString(),
		};
	} catch {
		return undefined;
	}
}

function openAICodexLoadAuthFromSeparateEnv(): OpenAICodexAuth | undefined {
	const accessToken = process.env[OPENAI_CODEX_ACCESS_TOKEN_ENV];
	const refreshToken = process.env[OPENAI_CODEX_REFRESH_TOKEN_ENV];
	if (!accessToken || !refreshToken) return undefined;
	const accountId =
		process.env[OPENAI_CODEX_ACCOUNT_ID_ENV] ?? openAICodexGetAccountId(accessToken);
	const expiresAt = openAICodexGetJwtExpiryMs(accessToken);
	if (!accountId || expiresAt === undefined) return undefined;

	return {
		access_token: accessToken,
		refresh_token: refreshToken,
		account_id: accountId,
		expires_at: expiresAt,
		last_refresh: new Date().toISOString(),
	};
}

function openAICodexParseFlatAuth(raw: string): OpenAICodexAuth | undefined {
	try {
		return v.parse(openAICodexFlatAuthSchema, JSON.parse(raw));
	} catch {
		return undefined;
	}
}

function openAICodexShouldRefreshAuth(auth: OpenAICodexAuth): boolean {
	return Date.now() >= auth.expires_at - OPENAI_CODEX_REFRESH_SKEW_MS;
}

function openAICodexGetJwtExpiryMs(token: string | undefined): number | undefined {
	const payload = openAICodexDecodeJwtPayload(token);
	return typeof payload?.exp === 'number' ? payload.exp * 1000 : undefined;
}

function openAICodexGetAccountId(token: string | undefined): string | undefined {
	const payload = openAICodexDecodeJwtPayload(token);
	const auth = payload?.['https://api.openai.com/auth'];
	const accountId =
		auth && typeof auth === 'object'
			? (auth as Record<string, unknown>).chatgpt_account_id
			: undefined;
	return typeof accountId === 'string' && accountId.length > 0 ? accountId : undefined;
}

function openAICodexDecodeJwtPayload(
	token: string | undefined,
): Record<string, unknown> | undefined {
	if (!token) return undefined;
	try {
		const [, payload] = token.split('.');
		if (!payload) return undefined;
		const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
		const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), '=');
		const decoded = JSON.parse(globalThis.atob(padded));
		return decoded && typeof decoded === 'object' ? decoded : undefined;
	} catch {
		return undefined;
	}
}
