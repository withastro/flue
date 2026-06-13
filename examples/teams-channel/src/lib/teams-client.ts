import type { TeamsConversationRef } from '@flue/teams';

export interface TeamsClientOptions {
	appId: string;
	appPassword: string;
	tenantId: string;
	oauthAuthority?: string;
	fetch?: typeof globalThis.fetch;
}

interface TeamsResourceResponse {
	id: string;
}

export interface TeamsClient {
	postMessage(ref: TeamsConversationRef, text: string): Promise<TeamsResourceResponse>;
}

export function createTeamsClient(options: TeamsClientOptions): TeamsClient {
	const fetcher = options.fetch ?? globalThis.fetch;
	const oauthAuthority =
		options.oauthAuthority ?? `https://login.microsoftonline.com/${options.tenantId}`;
	let accessToken: { value: string; expiresAt: number } | undefined;

	return {
		async postMessage(ref, text) {
			const token = await getAccessToken();
			const response = await fetcher(activityUrl(ref), {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body: JSON.stringify({
					type: 'message',
					from: { id: ref.botId },
					conversation: { id: ref.conversationId },
					...(ref.threadId === undefined ? {} : { replyToId: ref.threadId }),
					text,
				}),
			});
			if (!response.ok) {
				throw new Error(`Microsoft Teams message request failed with ${response.status}.`);
			}
			const result: unknown = await response.json();
			if (!isRecord(result) || typeof result.id !== 'string') {
				throw new Error('Microsoft Teams returned an invalid resource response.');
			}
			return { id: result.id };
		},
	};

	async function getAccessToken(): Promise<string> {
		if (accessToken && accessToken.expiresAt > Date.now() + 60_000) {
			return accessToken.value;
		}
		const endpoint = oauthTokenUrl(oauthAuthority);
		const response = await fetcher(endpoint, {
			method: 'POST',
			headers: { 'content-type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams({
				grant_type: 'client_credentials',
				client_id: options.appId,
				client_secret: options.appPassword,
				scope: 'https://api.botframework.com/.default',
			}),
		});
		if (!response.ok) {
			throw new Error(`Microsoft OAuth request failed with ${response.status}.`);
		}
		const result: unknown = await response.json();
		if (
			!isRecord(result) ||
			typeof result.access_token !== 'string' ||
			typeof result.expires_in !== 'number' ||
			!Number.isFinite(result.expires_in)
		) {
			throw new Error('Microsoft OAuth returned an invalid access token response.');
		}
		accessToken = {
			value: result.access_token,
			expiresAt: Date.now() + Math.max(0, result.expires_in) * 1000,
		};
		return accessToken.value;
	}
}

function oauthTokenUrl(authority: string): URL {
	const endpoint = new URL(authority);
	if (
		endpoint.protocol !== 'https:' ||
		endpoint.username !== '' ||
		endpoint.password !== '' ||
		endpoint.search !== '' ||
		endpoint.hash !== ''
	) {
		throw new Error('Microsoft OAuth authority is invalid.');
	}
	const prefix = endpoint.pathname.replace(/\/+$/, '');
	endpoint.pathname = `${prefix}/oauth2/v2.0/token`;
	return endpoint;
}

function activityUrl(ref: TeamsConversationRef): URL {
	const base = new URL(ref.serviceUrl);
	if (
		base.protocol !== 'https:' ||
		base.username !== '' ||
		base.password !== '' ||
		base.search !== '' ||
		base.hash !== ''
	) {
		throw new Error('Microsoft Teams service URL is invalid.');
	}
	const prefix = base.pathname.endsWith('/') ? base.pathname : `${base.pathname}/`;
	base.pathname = `${prefix}v3/conversations/${encodeURIComponent(ref.conversationId)}/activities`;
	if (ref.threadId !== undefined) {
		base.pathname += `/${encodeURIComponent(ref.threadId)}`;
	}
	return base;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
