import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { describe, expect, it, vi } from 'vitest';
import { createTeamsChannel } from '../src/index.ts';

describe('@flue/teams workerd ingress', () => {
	it('executes Bot Connector JWT and JWKS verification through the public route', async () => {
		const appId = 'workerd-app-id';
		const tenantId = 'workerd-tenant-id';
		const serviceUrl = 'https://smba.trafficmanager.net/workerd/';
		const issuer = 'https://api.botframework.com';
		const metadataUrl = 'https://login.botframework.test/workerd/openid';
		const jwksUrl = 'https://login.botframework.test/workerd/keys';
		const keyPair = await generateKeyPair('RS256');
		const publicJwk = await exportJWK(keyPair.publicKey);
		const fetcher = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === metadataUrl) {
				return Response.json({ issuer, jwks_uri: jwksUrl });
			}
			if (url === jwksUrl) {
				return Response.json({
					keys: [
						{
							...publicJwk,
							kid: 'workerd-key',
							alg: 'RS256',
							use: 'sig',
							endorsements: ['msteams'],
						},
					],
				});
			}
			return new Response(null, { status: 404 });
		});
		const activities = vi.fn(({ activity }: { activity: { type: string } }) => ({
			type: activity.type,
		}));
		const teams = createTeamsChannel({
			appId,
			tenantId,
			openIdMetadataUrl: metadataUrl,
			tokenIssuer: issuer,
			fetch: fetcher,
			activities,
		});
		const app = new Hono();
		for (const route of teams.routes) app.on(route.method, route.path, route.handler);
		const body = JSON.stringify({
			type: 'message',
			id: 'workerd-activity',
			serviceUrl,
			channelId: 'msteams',
			from: { id: 'workerd-user', tenantId },
			recipient: { id: 'workerd-bot', tenantId },
			conversation: { id: 'workerd-conversation', conversationType: 'personal', tenantId },
			channelData: { tenant: { id: tenantId } },
			text: 'workerd message',
		});
		const token = await new SignJWT({ serviceurl: serviceUrl })
			.setProtectedHeader({ alg: 'RS256', kid: 'workerd-key' })
			.setIssuer(issuer)
			.setAudience(appId)
			.setIssuedAt()
			.setExpirationTime('5m')
			.sign(keyPair.privateKey);

		const response = await app.request(
			new Request('https://example.test/activities', {
				method: 'POST',
				headers: {
					authorization: `Bearer ${token}`,
					'content-type': 'application/json',
				},
				body,
			}),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 'message' });
		expect(activities).toHaveBeenCalledOnce();
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
