import { Hono } from 'hono';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';
import {
	createNotionChannel,
	type NotionChannel,
	type NotionWebhookAuthorType,
	type NotionWebhookEvent,
	type NotionWebhookHandlerInput,
} from '../src/index.ts';

const encoder = new TextEncoder();

describe('createNotionChannel()', () => {
	it('delivers a verified native page event when exact bytes match', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_exact',
			webhook,
		});
		const body = ` {\n "id":"delivery_exact",\n "timestamp":"2026-06-13T22:10:00.000Z",\n "workspace_id":"workspace_acme",\n "workspace_name":"Acme",\n "subscription_id":"subscription_pages",\n "integration_id":"integration_agent",\n "authors":[{"id":"user_1","type":"person"},{"id":"agent_1","type":"agent"}],\n "accessible_by":[{"id":"bot_reader","type":"bot"}],\n "attempt_number":1,\n "api_version":"2026-03-11",\n "type":"page.created",\n "entity":{"id":"page_exact","type":"page"},\n "data":{"parent":{"id":"workspace_acme","type":"space"}}\n} `;
		const signature = await signatureHeader(body, 'notion_secret_exact');
		const app = channelApp(notion);

		const response = await app.request(jsonRequest(body, signature));
		const changed = await app.request(
			jsonRequest(body.replace('page_exact', 'page_changed'), signature),
		);

		expect(response.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({
			c: expect.any(Object),
			event: {
				id: 'delivery_exact',
				type: 'page.created',
				entity: { id: 'page_exact', type: 'page' },
				authors: [
					{ id: 'user_1', type: 'person' },
					{ id: 'agent_1', type: 'agent' },
				],
				accessible_by: [{ id: 'bot_reader', type: 'bot' }],
			},
		});
	});

	it('forwards a verified future event type with its native fields', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_future',
			webhook,
		});
		const body = JSON.stringify(
			notionEvent({
				id: 'delivery_future',
				type: 'workspace.member_invited',
				entity: { id: 'user_future', type: 'user' },
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_future')),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'workspace.member_invited',
			id: 'delivery_future',
			workspace_id: 'workspace_acme',
			attempt_number: 1,
			entity: { id: 'user_future', type: 'user' },
		});
	});

	it('forwards a familiar event under a future API version with its native fields', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_version',
			webhook,
		});
		const body = JSON.stringify(
			notionEvent({
				id: 'delivery_future_version',
				api_version: '2027-01-01',
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_version')),
		);

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'page.created',
			api_version: '2027-01-01',
		});
	});

	it('delivers a verified data-source event', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_data_source',
			webhook,
		});
		const body = JSON.stringify(
			notionEvent({
				type: 'data_source.schema_updated',
				entity: { id: 'data_source_1', type: 'data_source' },
				data: {
					parent: { id: 'database_1', type: 'database' },
					updated_properties: [{ id: 'title', name: 'Title', action: 'updated' }],
				},
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_data_source')),
		);

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'data_source.schema_updated',
			entity: { id: 'data_source_1', type: 'data_source' },
		});
	});

	it('delivers a verified database event', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_database',
			webhook,
		});
		const body = JSON.stringify(
			notionEvent({
				type: 'database.content_updated',
				entity: { id: 'database_1', type: 'database' },
				data: {
					parent: { id: 'workspace_acme', type: 'space' },
					updated_blocks: [{ id: 'page_2', type: 'page' }],
				},
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_database')),
		);

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'database.content_updated',
			entity: { id: 'database_1', type: 'database' },
		});
	});

	it('delivers a verified file-upload event without a data object', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_file',
			webhook,
		});
		const body = JSON.stringify(
			notionEvent({
				type: 'file_upload.completed',
				entity: { id: 'file_upload_1', type: 'file_upload' },
				data: undefined,
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_file')),
		);

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'file_upload.completed',
			entity: { id: 'file_upload_1', type: 'file_upload' },
		});
	});

	it('delivers a verified view event', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_view',
			webhook,
		});
		const body = JSON.stringify(
			notionEvent({
				type: 'view.updated',
				entity: { id: 'view_1', type: 'view' },
				data: {
					parent: { id: 'data_source_1', type: 'database' },
					updated_fields: ['filter', 'sorts'],
				},
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_view')),
		);

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'view.updated',
			entity: { id: 'view_1', type: 'view' },
		});
	});

	it('handles the initial unsigned verification token without invoking the webhook', async () => {
		const verification = vi.fn(() => ({ captured: true }));
		const webhook = vi.fn();
		const notion = createNotionChannel({ verification, webhook });

		const response = await channelApp(notion).request(
			jsonRequest(JSON.stringify({ verification_token: 'notion_setup_token' })),
		);

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ captured: true });
		expect(verification).toHaveBeenCalledWith({
			c: expect.any(Object),
			verificationToken: 'notion_setup_token',
		});
		expect(webhook).not.toHaveBeenCalled();
	});

	it('acknowledges only the configured verification token without a setup callback', async () => {
		const notion = createNotionChannel({
			verificationToken: 'notion_configured_token',
			webhook() {},
		});
		const app = channelApp(notion);

		const matching = await app.request(
			jsonRequest(JSON.stringify({ verification_token: 'notion_configured_token' })),
		);
		const mismatched = await app.request(
			jsonRequest(JSON.stringify({ verification_token: 'notion_different_token' })),
		);

		expect(matching.status).toBe(200);
		expect(mismatched.status).toBe(403);
	});

	it('does not run the setup callback after a verification token is configured', async () => {
		const verification = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_configured_token',
			verification,
			webhook() {},
		});
		const app = channelApp(notion);

		const matching = await app.request(
			jsonRequest(JSON.stringify({ verification_token: 'notion_configured_token' })),
		);
		const mismatched = await app.request(
			jsonRequest(JSON.stringify({ verification_token: 'attacker_controlled_token' })),
		);

		expect(matching.status).toBe(200);
		expect(mismatched.status).toBe(403);
		expect(verification).not.toHaveBeenCalled();
	});

	it('returns 503 for signed events while the verification token is not configured', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verification() {},
			webhook,
		});
		const body = JSON.stringify(notionEvent());

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_not_configured')),
		);

		expect(response.status).toBe(503);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects missing, malformed, and incorrect signatures before application code', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_auth',
			webhook,
		});
		const app = channelApp(notion);
		const body = JSON.stringify(notionEvent());

		const missing = await app.request(jsonRequest(body));
		const malformed = await app.request(jsonRequest(body, 'sha256=not-hex'));
		const incorrect = await app.request(
			jsonRequest(body, await signatureHeader(body, 'notion_other_secret')),
		);

		expect(missing.status).toBe(401);
		expect(malformed.status).toBe(401);
		expect(incorrect.status).toBe(401);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects unparseable or untyped signed bodies', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_identity',
			webhook,
		});
		const app = channelApp(notion);
		const malformed = '{"type":';
		const untyped = JSON.stringify({ id: 'delivery_untyped', workspace_id: 'workspace_acme' });

		const malformedResponse = await app.request(
			jsonRequest(malformed, await signatureHeader(malformed, 'notion_secret_identity')),
		);
		const untypedResponse = await app.request(
			jsonRequest(untyped, await signatureHeader(untyped, 'notion_secret_identity')),
		);

		expect(malformedResponse.status).toBe(400);
		expect(untypedResponse.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('forwards verified events with their native fields without structural reshaping', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_native',
			webhook,
		});
		// A page event whose `data` is absent and whose authors include `agent`:
		// the channel forwards it as-is rather than rejecting it on shape.
		const body = JSON.stringify(
			notionEvent({
				data: undefined,
				authors: [{ id: 'agent_1', type: 'agent' }],
			}),
		);

		const response = await channelApp(notion).request(
			jsonRequest(body, await signatureHeader(body, 'notion_secret_native')),
		);

		expect(response.status).toBe(200);
		expect(webhook.mock.calls[0]?.[0].event).toMatchObject({
			type: 'page.created',
			authors: [{ id: 'agent_1', type: 'agent' }],
		});
	});

	it('enforces media type and declared or streamed body limits', async () => {
		const webhook = vi.fn();
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_limit',
			bodyLimit: 24,
			webhook,
		});
		const app = channelApp(notion);
		const wrongType = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: '{}',
			}),
		);
		const declared = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': '25',
				},
				body: '{}',
			}),
		);
		const malformedLength = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'content-length': 'invalid',
				},
				body: '{}',
			}),
		);
		const streamed = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(encoder.encode('{"verification_token":"too-large"}'));
						controller.close();
					},
				}),
				duplex: 'half',
			} as RequestInit & { duplex: 'half' }),
		);

		expect(wrongType.status).toBe(415);
		expect(declared.status).toBe(413);
		expect(malformedLength.status).toBe(400);
		expect(streamed.status).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('serializes empty, JSON, and Response results and contains handler failures', async () => {
		const body = JSON.stringify(notionEvent());
		const cases = [
			{
				handler: () => undefined,
				assert: async (response: Response) => {
					expect(response.status).toBe(200);
					expect(await response.text()).toBe('');
				},
			},
			{
				handler: () => ({ accepted: true }),
				assert: async (response: Response) => {
					expect(response.status).toBe(200);
					await expect(response.json()).resolves.toEqual({ accepted: true });
				},
			},
			{
				handler: () => new Response('queued', { status: 202 }),
				assert: async (response: Response) => {
					expect(response.status).toBe(202);
					expect(await response.text()).toBe('queued');
				},
			},
			{
				handler: () => {
					throw new Error('application failure');
				},
				assert: async (response: Response) => {
					expect(response.status).toBe(500);
					expect(await response.text()).toBe('');
				},
			},
			{
				// A non-plain value is no longer a clean 500: it serializes through
				// `Response.json`. A `Date` becomes its ISO string; `NaN` becomes `null`.
				handler: () => new Date('2026-06-13T00:00:00.000Z') as never,
				assert: async (response: Response) => {
					expect(response.status).toBe(200);
					await expect(response.json()).resolves.toBe('2026-06-13T00:00:00.000Z');
				},
			},
			{
				handler: () => Number.NaN as never,
				assert: async (response: Response) => {
					expect(response.status).toBe(200);
					await expect(response.json()).resolves.toBeNull();
				},
			},
		];

		for (const testCase of cases) {
			const notion = createNotionChannel({
				verificationToken: 'notion_secret_result',
				webhook: testCase.handler,
			});
			const response = await channelApp(notion).request(
				jsonRequest(body, await signatureHeader(body, 'notion_secret_result')),
			);
			await testCase.assert(response);
		}
	});

	it('publishes one fixed route and exposes provider-native typed events', () => {
		const notion = createNotionChannel({
			verificationToken: 'notion_secret_route',
			webhook({ event }) {
				// Modeled events carry the official SDK payload shape, including the
				// documented `agent` author principal that the SDK type omits.
				const pageCreated = event as Extract<NotionWebhookEvent, { type: 'page.created' }>;
				expectTypeOf(pageCreated.entity.id).toEqualTypeOf<string>();
				expectTypeOf(pageCreated.data.parent.type).toEqualTypeOf<
					'space' | 'block' | 'page' | 'database' | 'team' | 'agent'
				>();
				expectTypeOf(pageCreated.authors[0]!.type).toEqualTypeOf<NotionWebhookAuthorType>();
				// Authenticated future/unknown event types are still forwarded at
				// runtime (see the forwarding tests above), but they are not part of
				// the official modeled union and are reached via a `default` arm
				// rather than being statically typed here.
			},
		});
		expect(notion.routes).toHaveLength(1);
		expect(notion.routes[0]).toMatchObject({ method: 'POST', path: '/webhook' });
		expectTypeOf<NotionWebhookHandlerInput['c']>().toMatchTypeOf<object>();
	});

	it('rejects invalid constructor options', () => {
		expect(() =>
			createNotionChannel({
				webhook() {},
			}),
		).toThrow(TypeError);
		expect(() =>
			createNotionChannel({
				verificationToken: '',
				webhook() {},
			}),
		).toThrow(TypeError);
		expect(() =>
			createNotionChannel({
				verification() {},
				bodyLimit: 0,
				webhook() {},
			}),
		).toThrow(TypeError);
	});
});

function notionEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		id: 'delivery_1',
		timestamp: '2026-06-13T22:10:00.000Z',
		workspace_id: 'workspace_acme',
		workspace_name: 'Acme',
		subscription_id: 'subscription_pages',
		integration_id: 'integration_agent',
		authors: [{ id: 'user_1', type: 'person' }],
		accessible_by: [{ id: 'bot_reader', type: 'bot' }],
		attempt_number: 1,
		api_version: '2026-03-11',
		type: 'page.created',
		entity: { id: 'page_1', type: 'page' },
		data: { parent: { id: 'workspace_acme', type: 'space' } },
		...overrides,
	};
}

function channelApp(channel: NotionChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function jsonRequest(body: string, signature?: string): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(signature ? { 'x-notion-signature': signature } : {}),
		},
		body,
	});
}

async function signatureHeader(body: string, secret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const digest = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
	const signature = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
	return `sha256=${signature}`;
}
