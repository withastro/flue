import { Hono } from 'hono';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import {
	createTeamsChannel,
	InvalidTeamsConversationKeyError,
	InvalidTeamsInputError,
	type TeamsChannel,
} from '../src/index.ts';

const APP_ID = '00000000-1111-2222-3333-444444444444';
const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ISSUER = 'https://api.botframework.com';
const METADATA_URL = 'https://login.botframework.test/openid';
const JWKS_URL = 'https://login.botframework.test/keys';
const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
const keyPair = await generateKeyPair('RS256');
const publicJwk = await signingJwk(keyPair.publicKey, 'key-1', ['msteams']);

type TestSigningJwk = JWK & {
	kid: string;
	endorsements: readonly string[];
};

describe('createTeamsChannel()', () => {
	it('declares one fixed activities route without invoking the callback eagerly', () => {
		const activities = vi.fn();
		const teams = createTeamsChannel({
			appId: APP_ID,
			tenantId: TENANT_ID,
			openIdMetadataUrl: METADATA_URL,
			tokenIssuer: ISSUER,
			fetch: discoveryFetch([publicJwk]),
			activities,
		});

		expect(teams.routes).toEqual([
			{ method: 'POST', path: '/activities', handler: expect.any(Function) },
		]);
		expect(activities).not.toHaveBeenCalled();
	});

	it('verifies and forwards the provider-native activity with a derived destination', async () => {
		const activities = vi.fn((_input: unknown) => ({ accepted: true }));
		const teams = testChannel({ activities });
		const raw = messageActivity({
			text: '<at>Flue Bot</at> review café',
			from: {
				id: '29:user-id',
				name: 'Ada',
				aadObjectId: 'user-object-id',
				tenantId: 'external-user-tenant',
			},
			entities: [
				{
					type: 'mention',
					text: '<at>Flue Bot</at>',
					mentioned: { id: '28:bot-id', name: 'Flue Bot' },
				},
				{ type: 'clientInfo', locale: 'en-US' },
			],
			attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive' }],
			value: { action: 'review' },
		});

		const response = await channelApp(teams).request(await signedRequest(raw));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ accepted: true });
		const input = activities.mock.calls[0]?.[0] as { activity: unknown } | undefined;
		// The provider-native activity is forwarded unmodified.
		expect(input?.activity).toEqual(raw);
		// The canonical routing identity is derived through the channel helper.
		expect(teams.destination(raw as never)).toEqual({
			tenantId: TENANT_ID,
			serviceUrl: SERVICE_URL,
			conversationId: 'conversation-1',
			scope: 'channel',
			botId: '28:bot-id',
			threadId: 'root-message-1',
			teamId: 'team-1',
			channelId: 'channel-1',
		});
	});

	it('forwards conversation updates invokes reactions and other activity types unmodified', async () => {
		const seen: unknown[] = [];
		const teams = testChannel({
			activities({ activity }) {
				seen.push(activity);
			},
		});
		const app = channelApp(teams);

		const conversationUpdate = messageActivity({
			type: 'conversationUpdate',
			membersAdded: [{ id: '29:new-user', name: 'Grace' }],
			membersRemoved: [{ id: '29:old-user' }],
			topicName: 'Synthetic launch',
		});
		const invokeActivity = messageActivity({
			type: 'invoke',
			name: 'adaptiveCard/action',
			value: { action: { type: 'Action.Execute', verb: 'approve' } },
		});
		const reactionActivity = messageActivity({
			type: 'messageReaction',
			reactionsAdded: [{ type: 'heart' }],
			reactionsRemoved: [{ type: 'like' }],
		});
		const installationActivity = messageActivity({ type: 'installationUpdate', action: 'add' });

		const update = await app.request(await signedRequest(conversationUpdate));
		const invoke = await app.request(await signedRequest(invokeActivity));
		const reaction = await app.request(await signedRequest(reactionActivity));
		const unknown = await app.request(await signedRequest(installationActivity));

		expect([update.status, invoke.status, reaction.status, unknown.status]).toEqual([
			200, 200, 200, 200,
		]);
		// Each activity is forwarded with Bot Framework's native type and field names.
		expect(seen).toEqual([
			conversationUpdate,
			invokeActivity,
			reactionActivity,
			installationActivity,
		]);
	});

	it('uses an empty 200 default and passes JSON and Hono responses through', async () => {
		const empty = testChannel({ activities() {} });
		const json = testChannel({ activities: () => ({ status: 'accepted' }) });
		const hono = testChannel({
			activities: ({ c }) => c.json({ status: 'queued' }, 202),
		});

		const emptyResponse = await channelApp(empty).request(await signedRequest(messageActivity()));
		const jsonResponse = await channelApp(json).request(await signedRequest(messageActivity()));
		const honoResponse = await channelApp(hono).request(await signedRequest(messageActivity()));

		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.text()).toBe('');
		expect(await jsonResponse.json()).toEqual({ status: 'accepted' });
		expect(honoResponse.status).toBe(202);
		expect(await honoResponse.json()).toEqual({ status: 'queued' });
	});

	it('lets the Hono error handler handle callback failures', async () => {
		const failure = new Error('failed');
		const throwing = testChannel({
			activities() {
				throw failure;
			},
		});
		const app = channelApp(throwing);
		let received: Error | undefined;
		app.onError((error, c) => {
			received = error;
			return c.text('handled', 503);
		});

		const response = await app.request(await signedRequest(messageActivity()));

		expect(response.status).toBe(503);
		expect(await response.text()).toBe('handled');
		expect(received).toBe(failure);
	});

	it('rejects missing invalid expired and wrong-audience bearer tokens', async () => {
		const activities = vi.fn();
		const teams = testChannel({ activities });
		const app = channelApp(teams);
		const raw = messageActivity();
		const body = JSON.stringify(raw);
		const invalid = new Request('https://example.test/activities', {
			method: 'POST',
			headers: {
				authorization: 'Bearer invalid.token.value',
				'content-type': 'application/json',
			},
			body,
		});

		const missingResponse = await app.request(
			new Request('https://example.test/activities', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
		);
		const invalidResponse = await app.request(invalid);
		const expiredResponse = await app.request(
			await signedRequest(raw, {
				expirationTime: Math.floor(Date.now() / 1000) - 6 * 60,
			}),
		);
		const wrongAudienceResponse = await app.request(
			await signedRequest(raw, { audience: 'different-app-id' }),
		);

		expect([
			missingResponse.status,
			invalidResponse.status,
			expiredResponse.status,
			wrongAudienceResponse.status,
		]).toEqual([401, 401, 401, 401]);
		expect(activities).not.toHaveBeenCalled();
	});

	it('accepts expiration skew within five minutes and rejects skew beyond it', async () => {
		const activities = vi.fn();
		const app = channelApp(testChannel({ activities }));
		const now = Math.floor(Date.now() / 1000);

		const accepted = await app.request(
			await signedRequest(messageActivity(), { expirationTime: now - 4 * 60 }),
		);
		const rejected = await app.request(
			await signedRequest(messageActivity(), { expirationTime: now - 6 * 60 }),
		);

		expect(accepted.status).toBe(200);
		expect(rejected.status).toBe(401);
		expect(activities).toHaveBeenCalledOnce();
	});

	it('rejects unendorsed channels service URL changes and tenant contradictions', async () => {
		const activities = vi.fn();
		const unendorsed = createTeamsChannel({
			appId: APP_ID,
			tenantId: TENANT_ID,
			openIdMetadataUrl: METADATA_URL,
			tokenIssuer: ISSUER,
			fetch: discoveryFetch([{ ...publicJwk, endorsements: ['webchat'] }]),
			activities,
		});
		const normal = testChannel({ activities });

		const unendorsedResponse = await channelApp(unendorsed).request(
			await signedRequest(messageActivity()),
		);
		const serviceMismatchResponse = await channelApp(normal).request(
			await signedRequest(messageActivity({ serviceUrl: 'https://changed.example.test/' })),
		);
		const tenantMismatchResponse = await channelApp(normal).request(
			await signedRequest(
				messageActivity({
					channelData: {
						tenant: { id: 'different-tenant' },
						team: { id: 'team-1' },
						channel: { id: 'channel-1' },
					},
				}),
			),
		);

		expect([
			unendorsedResponse.status,
			serviceMismatchResponse.status,
			tenantMismatchResponse.status,
		]).toEqual([401, 401, 403]);
		expect(activities).not.toHaveBeenCalled();
	});

	it('refreshes signing keys once when a valid rotated key id is not cached', async () => {
		const rotatedPair = await generateKeyPair('RS256');
		const rotatedJwk = await signingJwk(rotatedPair.publicKey, 'key-2', ['msteams']);
		let keyRequest = 0;
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === METADATA_URL) {
				return Response.json(
					{ issuer: ISSUER, jwks_uri: JWKS_URL },
					{ headers: { 'cache-control': 'max-age=3600' } },
				);
			}
			if (url === JWKS_URL) {
				keyRequest += 1;
				return Response.json(
					{ keys: keyRequest === 1 ? [publicJwk] : [publicJwk, rotatedJwk] },
					{ headers: { 'cache-control': 'max-age=3600' } },
				);
			}
			return new Response(null, { status: 404 });
		});
		const activities = vi.fn();
		const teams = createTeamsChannel({
			appId: APP_ID,
			tenantId: TENANT_ID,
			openIdMetadataUrl: METADATA_URL,
			tokenIssuer: ISSUER,
			fetch: fetcher,
			activities,
		});

		const response = await channelApp(teams).request(
			await signedRequest(messageActivity(), {
				kid: 'key-2',
				privateKey: rotatedPair.privateKey,
			}),
		);

		expect(response.status).toBe(200);
		expect(keyRequest).toBe(2);
		expect(activities).toHaveBeenCalledOnce();
	});

	it('returns 503 when OpenID discovery is unavailable', async () => {
		const activities = vi.fn();
		const teams = createTeamsChannel({
			appId: APP_ID,
			tenantId: TENANT_ID,
			openIdMetadataUrl: METADATA_URL,
			tokenIssuer: ISSUER,
			fetch: vi.fn(async () => new Response(null, { status: 503 })),
			activities,
		});

		const response = await channelApp(teams).request(await signedRequest(messageActivity()));

		expect(response.status).toBe(503);
		expect(activities).not.toHaveBeenCalled();
	});

	it('rejects unsupported media malformed bodies oversized bodies and wrong Teams channels', async () => {
		const activities = vi.fn();
		const teams = testChannel({ bodyLimit: 256, activities });
		const app = channelApp(teams);
		const unsupported = await app.request(
			new Request('https://example.test/activities', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: 'hello',
			}),
		);
		const malformed = await app.request(await signedRequest('{broken', { bodyIsRaw: true }));
		const oversized = await app.request(
			await signedRequest(messageActivity({ text: 'x'.repeat(500) })),
		);
		const wrongChannel = await channelApp(testChannel({ activities })).request(
			await signedRequest(messageActivity({ channelId: 'webchat' })),
		);

		expect([unsupported.status, malformed.status, oversized.status, wrongChannel.status]).toEqual([
			415, 400, 413, 403,
		]);
		expect(activities).not.toHaveBeenCalled();
	});

	it('round-trips canonical conversation references without treating them as authorization', () => {
		const teams = testChannel({ activities() {} });
		const ref = {
			tenantId: TENANT_ID,
			serviceUrl: 'https://smba.trafficmanager.net/amer/',
			conversationId: '19:conversation:with/slashes',
			scope: 'channel' as const,
			botId: '28:bot:id',
			threadId: 'root:1',
			teamId: 'team:1',
			channelId: 'channel/1',
		};
		const key = teams.conversationKey(ref);

		expect(teams.parseConversationKey(key)).toEqual(ref);
		expect(() => teams.parseConversationKey(`slack:${key}`)).toThrow(
			InvalidTeamsConversationKeyError,
		);
	});

	it('rejects invalid constructor and conversation inputs', () => {
		expect(() =>
			createTeamsChannel({
				appId: '',
				tenantId: TENANT_ID,
				openIdMetadataUrl: METADATA_URL,
				activities() {},
			}),
		).toThrow(InvalidTeamsInputError);
		const teams = testChannel({ activities() {} });
		expect(() =>
			teams.conversationKey({
				tenantId: TENANT_ID,
				serviceUrl: 'http://unsafe.example.test/',
				conversationId: 'C1',
				scope: 'personal',
				botId: 'B1',
			}),
		).toThrow(InvalidTeamsInputError);
		// destination() throws when the activity lacks the minimal reply structure.
		expect(() => teams.destination({ type: 'message' } as never)).toThrow(InvalidTeamsInputError);
	});
});

function testChannel(
	overrides: Partial<Parameters<typeof createTeamsChannel>[0]> & {
		activities: Parameters<typeof createTeamsChannel>[0]['activities'];
	},
): TeamsChannel {
	return createTeamsChannel({
		appId: APP_ID,
		tenantId: TENANT_ID,
		openIdMetadataUrl: METADATA_URL,
		tokenIssuer: ISSUER,
		fetch: discoveryFetch([publicJwk]),
		...overrides,
	});
}

function channelApp(channel: TeamsChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function messageActivity(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		type: 'message',
		id: 'activity-1',
		timestamp: '2026-06-13T17:20:00.000Z',
		serviceUrl: SERVICE_URL,
		channelId: 'msteams',
		from: {
			id: '29:user-id',
			name: 'Ada',
			aadObjectId: 'user-object-id',
			tenantId: TENANT_ID,
		},
		recipient: {
			id: '28:bot-id',
			name: 'Flue Bot',
			tenantId: TENANT_ID,
		},
		conversation: {
			id: 'conversation-1',
			conversationType: 'channel',
			tenantId: TENANT_ID,
		},
		replyToId: 'root-message-1',
		channelData: {
			tenant: { id: TENANT_ID },
			team: { id: 'team-1' },
			channel: { id: 'channel-1' },
		},
		locale: 'en-US',
		text: 'hello',
		...overrides,
	};
}

async function signedRequest(
	raw: unknown,
	options: {
		audience?: string;
		expirationTime?: number;
		kid?: string;
		privateKey?: CryptoKey;
		bodyIsRaw?: boolean;
	} = {},
): Promise<Request> {
	const body = options.bodyIsRaw ? String(raw) : JSON.stringify(raw);
	const token = await new SignJWT({ serviceurl: SERVICE_URL })
		.setProtectedHeader({ alg: 'RS256', kid: options.kid ?? 'key-1' })
		.setIssuer(ISSUER)
		.setAudience(options.audience ?? APP_ID)
		.setIssuedAt()
		.setExpirationTime(options.expirationTime ?? '5m')
		.sign(options.privateKey ?? keyPair.privateKey);
	return new Request('https://example.test/activities', {
		method: 'POST',
		headers: {
			authorization: `Bearer ${token}`,
			'content-type': 'application/json',
		},
		body,
	});
}

function discoveryFetch(keys: readonly TestSigningJwk[]): typeof globalThis.fetch {
	return async (input) => {
		const url = String(input);
		if (url === METADATA_URL) {
			return Response.json(
				{ issuer: ISSUER, jwks_uri: JWKS_URL },
				{ headers: { 'cache-control': 'max-age=3600' } },
			);
		}
		if (url === JWKS_URL) {
			return Response.json({ keys }, { headers: { 'cache-control': 'max-age=3600' } });
		}
		return new Response(null, { status: 404 });
	};
}

async function signingJwk(
	key: CryptoKey,
	kid: string,
	endorsements: readonly string[],
): Promise<TestSigningJwk> {
	return {
		...(await exportJWK(key)),
		kid,
		use: 'sig',
		alg: 'RS256',
		endorsements,
	};
}
