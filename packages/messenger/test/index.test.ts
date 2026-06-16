import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createMessengerChannel,
	InvalidMessengerConversationKeyError,
	type InvalidMessengerInputError,
	type MessengerChannel,
	type MessengerConversationRef,
	type MessengerMessagingEvent,
	type MessengerWebhookPayload,
} from '../src/index.ts';

describe('createMessengerChannel()', () => {
	it('answers one valid verification challenge and rejects invalid query shapes', async () => {
		const channel = createMessengerChannel({
			appSecret: 'app-secret-copper',
			verifyToken: 'verify-token-copper',
			pageId: 'page_copper_41',
			webhook() {},
		});
		const app = channelApp(channel);

		const accepted = await app.request(
			'https://hooks.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=challenge-copper&hub.verify_token=verify-token-copper',
		);
		const wrongToken = await app.request(
			'https://hooks.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=challenge-copper&hub.verify_token=wrong-token',
		);
		const duplicate = await app.request(
			'https://hooks.example.test/channels/messenger/webhook?hub.mode=subscribe&hub.challenge=challenge-copper&hub.verify_token=verify-token-copper&hub.verify_token=verify-token-copper',
		);

		expect(accepted.status).toBe(200);
		expect(accepted.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
		expect(await accepted.text()).toBe('challenge-copper');
		expect(wrongToken.status).toBe(403);
		expect(duplicate.status).toBe(400);
	});

	it('verifies and forwards the provider-native batch unchanged in delivered order', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-amber',
			verifyToken: 'verify-token-amber',
			pageId: 'page_amber_42',
			webhook,
		});
		const message = {
			sender: { id: 'psid_amber_43' },
			recipient: { id: 'page_amber_42' },
			timestamp: 1_781_350_000_002,
			message: {
				mid: 'm_amber_message_44',
				text: 'Inspect the west loading bay.',
				quick_reply: { payload: 'bay-west' },
				reply_to: { mid: 'm_amber_parent_45', is_self_reply: false },
				attachments: [
					{
						type: 'sticker',
						payload: {
							url: 'https://cdn.example.test/sticker-amber.webp',
							sticker_id: 4601,
						},
					},
				],
				commands: [{ name: 'inspect' }],
			},
		};
		const edit = {
			sender: { id: 'psid_amber_43' },
			recipient: { id: 'page_amber_42' },
			timestamp: 1_781_350_000_003,
			message_edit: {
				mid: 'm_amber_message_44',
				text: 'Inspect the west loading bay first.',
				num_edit: 1,
			},
		};
		const reaction = {
			sender: { id: 'psid_amber_43' },
			recipient: { id: 'page_amber_42' },
			timestamp: 1_781_350_000_004,
			reaction: {
				mid: 'm_amber_reply_46',
				action: 'react',
				reaction: 'other',
				emoji: '🟧',
			},
		};
		const future = {
			sender: { id: 'psid_amber_43' },
			recipient: { id: 'page_amber_42' },
			timestamp: 1_781_350_000_005,
			future_signal: { color: 'amber' },
		};
		const body = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_amber_42',
					time: 1_781_350_000_001,
					messaging: [message, edit, reaction, future],
				},
			],
		});

		const result = await channelApp(channel).request(await signedRequest(body, 'app-secret-amber'));

		expect(result.status).toBe(200);
		expect(result.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
		expect(await result.text()).toBe('EVENT_RECEIVED');
		expect(webhook).toHaveBeenCalledOnce();
		const payload = webhook.mock.calls[0]?.[0].payload as MessengerWebhookPayload;
		// The payload is the parsed wire object, untouched.
		expect(payload).toEqual(JSON.parse(body));
		expect(payload.entry[0]?.messaging).toEqual([message, edit, reaction, future]);
		// Native discriminant-by-property-presence and snake_case fields survive.
		const first = payload.entry[0]?.messaging?.[0];
		expect(first?.message?.mid).toBe('m_amber_message_44');
		expect(first?.message?.quick_reply?.payload).toBe('bay-west');
		expect(first?.message?.attachments?.[0]?.payload?.sticker_id).toBe(4601);
		expect(payload.entry[0]?.messaging?.[3]?.future_signal).toEqual({
			color: 'amber',
		});
	});

	it('forwards change-shaped, opt-in, standby, and echo deliveries without reshaping', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-violet',
			verifyToken: 'verify-token-violet',
			pageId: 'page_violet_47',
			webhook,
		});
		const body = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_violet_47',
					time: 1_781_350_100_001,
					messaging: [
						{
							sender: { id: 'page_violet_47' },
							recipient: { id: 'psid_violet_50' },
							timestamp: 1_781_350_100_000,
							message: {
								mid: 'm_violet_echo_51',
								is_echo: true,
								app_id: 5401,
								metadata: 'violet-metadata',
								text: 'Echoed reply',
							},
						},
						{
							sender: { id: 'psid_violet_50' },
							recipient: { id: 'page_violet_47' },
							timestamp: '1781350100002',
							optin: {
								type: 'notification_messages',
								payload: 'shipment-violet',
								notification_messages_token: 'capability-violet',
								token_expiry_timestamp: 1_789_126_100,
							},
						},
					],
					standby: [
						{
							sender: { id: 'psid_violet_50' },
							recipient: { id: 'page_violet_47' },
							timestamp: 1_781_350_100_003,
							message: { mid: 'm_violet_standby_52', text: 'Owned by another app' },
						},
					],
					changes: [
						{
							field: 'messaging_postbacks',
							value: {
								sender: { user_ref: 'user_ref_violet_48' },
								recipient: { id: 'page_violet_47' },
								postback: {
									mid: 'm_violet_postback_49',
									title: 'Open violet queue',
									payload: 'queue-violet',
								},
							},
						},
					],
				},
			],
		});

		const result = await channelApp(channel).request(
			await signedRequest(body, 'app-secret-violet'),
		);

		expect(result.status).toBe(200);
		const payload = webhook.mock.calls[0]?.[0].payload as MessengerWebhookPayload;
		expect(payload).toEqual(JSON.parse(body));
		const entry = payload.entry[0];
		// Echo, opt-in token, standby, and changes all arrive native and intact.
		expect(entry?.messaging?.[0]?.message?.is_echo).toBe(true);
		expect(entry?.messaging?.[1]?.optin?.notification_messages_token).toBe('capability-violet');
		expect(entry?.standby?.[0]?.message?.mid).toBe('m_violet_standby_52');
		expect(entry?.changes?.[0]?.field).toBe('messaging_postbacks');
		// String timestamps are preserved verbatim, not coerced.
		expect(entry?.messaging?.[1]?.timestamp).toBe('1781350100002');
	});

	it('rejects changed signatures, wrong Page identity, malformed bodies, and oversized bodies', async () => {
		const webhook = vi.fn();
		const channel = createMessengerChannel({
			appSecret: 'app-secret-cedar',
			verifyToken: 'verify-token-cedar',
			pageId: 'page_cedar_55',
			bodyLimit: 700,
			webhook,
		});
		const valid = JSON.stringify({
			object: 'page',
			entry: [
				{
					id: 'page_cedar_55',
					time: 1_781_350_300_001,
					messaging: [
						{
							sender: { id: 'psid_cedar_56' },
							recipient: { id: 'page_cedar_55' },
							timestamp: 1_781_350_300_002,
							message: { mid: 'm_cedar_57', text: 'Cedar résumé' },
						},
					],
				},
			],
		});
		const changed = valid.replace('résumé', 'resume');
		const invalidSignature = new Request('https://hooks.example.test/channels/messenger/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'x-hub-signature-256': await signature(valid, 'app-secret-cedar'),
			},
			body: changed,
		});
		const wrongPageBody = valid.replaceAll('page_cedar_55', 'page_other_58');
		const malformedBody = '{"object":"page","entry":"not-an-array"}';
		const app = channelApp(channel);

		const changedResult = await app.request(invalidSignature);
		const wrongPage = await app.request(await signedRequest(wrongPageBody, 'app-secret-cedar'));
		const malformed = await app.request(await signedRequest(malformedBody, 'app-secret-cedar'));
		const unsupported = await app.request('https://hooks.example.test/channels/messenger/webhook', {
			method: 'POST',
			headers: { 'content-type': 'text/plain' },
			body: valid,
		});
		const oversized = await app.request('https://hooks.example.test/channels/messenger/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'application/json',
				'content-length': '701',
				'x-hub-signature-256': await signature(valid, 'app-secret-cedar'),
			},
			body: valid,
		});

		expect(changedResult.status).toBe(401);
		expect(wrongPage.status).toBe(403);
		expect(malformed.status).toBe(400);
		expect(unsupported.status).toBe(415);
		expect(oversized.status).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('passes through JSON and Response handler values', async () => {
		const base = {
			object: 'page',
			entry: [
				{
					id: 'page_fir_59',
					time: 1_781_350_400_001,
					messaging: [
						{
							sender: { id: 'psid_fir_60' },
							recipient: { id: 'page_fir_59' },
							timestamp: 1_781_350_400_002,
							message: { mid: 'm_fir_61', text: 'Response control' },
						},
					],
				},
			],
		};
		const jsonChannel = createMessengerChannel({
			appSecret: 'app-secret-fir',
			verifyToken: 'verify-token-fir',
			pageId: 'page_fir_59',
			webhook() {
				return { received: true };
			},
		});
		const responseChannel = createMessengerChannel({
			appSecret: 'app-secret-fir',
			verifyToken: 'verify-token-fir',
			pageId: 'page_fir_59',
			webhook({ c }) {
				return c.text('custom-fir', 202);
			},
		});
		const body = JSON.stringify(base);

		const json = await channelApp(jsonChannel).request(await signedRequest(body, 'app-secret-fir'));
		const custom = await channelApp(responseChannel).request(
			await signedRequest(body, 'app-secret-fir'),
		);

		expect(json.status).toBe(200);
		expect(await json.json()).toEqual({ received: true });
		expect(custom.status).toBe(202);
		expect(await custom.text()).toBe('custom-fir');
	});

	it('derives counterpart participants for inbound and echo events', () => {
		const channel = createMessengerChannel({
			appSecret: 'app-secret-iris',
			verifyToken: 'verify-token-iris',
			pageId: 'page_iris_65',
			webhook() {},
		});
		const inbound: MessengerMessagingEvent = {
			sender: { id: 'psid_iris_66' },
			recipient: { id: 'page_iris_65' },
			message: { mid: 'm_iris_67', text: 'hi' },
		};
		const echo: MessengerMessagingEvent = {
			sender: { id: 'page_iris_65' },
			recipient: { id: 'psid_iris_66' },
			message: { mid: 'm_iris_68', is_echo: true },
		};
		const userRef: MessengerMessagingEvent = {
			sender: { user_ref: 'user_ref_iris_69' },
			recipient: { id: 'page_iris_65' },
		};
		const pageToPage: MessengerMessagingEvent = {
			sender: { id: 'page_iris_65' },
			recipient: { id: 'page_iris_65' },
		};

		expect(channel.conversationRef(inbound)).toEqual({
			pageId: 'page_iris_65',
			participant: { type: 'page-scoped-id', id: 'psid_iris_66' },
		});
		expect(channel.conversationRef(echo)).toEqual({
			pageId: 'page_iris_65',
			participant: { type: 'page-scoped-id', id: 'psid_iris_66' },
		});
		expect(channel.conversationRef(userRef)).toEqual({
			pageId: 'page_iris_65',
			participant: { type: 'user-ref', id: 'user_ref_iris_69' },
		});
		expect(channel.conversationRef(pageToPage)).toBeUndefined();
		expect(channel.conversationRef({})).toBeUndefined();
	});

	it('round-trips canonical participant keys and validates constructor options', () => {
		const channel = createMessengerChannel({
			appSecret: 'app-secret-oak',
			verifyToken: 'verify-token-oak',
			pageId: 'page_oak_62',
			webhook() {},
		});
		const refs: MessengerConversationRef[] = [
			{
				pageId: 'page_oak_62',
				participant: { type: 'page-scoped-id', id: 'psid:oak/63' },
			},
			{
				pageId: 'page_oak_62',
				participant: { type: 'user-ref', id: 'user ref oak 64' },
			},
		];
		for (const ref of refs) {
			const id = channel.conversationKey(ref);
			expect(channel.parseConversationKey(id)).toEqual(ref);
		}
		expect(() =>
			channel.parseConversationKey('messenger:v1:page:page_oak_62:page-scoped-id:%70sid'),
		).toThrow(InvalidMessengerConversationKeyError);
		expect(() =>
			createMessengerChannel({
				appSecret: '',
				verifyToken: 'verify-token-oak',
				pageId: 'page_oak_62',
				webhook() {},
			}),
		).toThrowError(
			expect.objectContaining<Partial<InvalidMessengerInputError>>({
				field: 'appSecret',
			}),
		);
	});
});

function channelApp(channel: MessengerChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) {
		app.on(route.method, `/channels/messenger${route.path}`, route.handler);
	}
	return app;
}

async function signedRequest(body: string, appSecret: string): Promise<Request> {
	return new Request('https://hooks.example.test/channels/messenger/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			'x-hub-signature-256': await signature(body, appSecret),
		},
		body,
	});
}

async function signature(body: string, appSecret: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(appSecret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const bytes = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)),
	);
	return `sha256=${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
