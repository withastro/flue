import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createWhatsAppChannel,
	InvalidWhatsAppConversationKeyError,
	InvalidWhatsAppInputError,
	type WhatsAppChannel,
	type WhatsAppConversationRef,
	type WhatsAppWebhookPayload,
} from '../src/index.ts';

const encoder = new TextEncoder();

describe('createWhatsAppChannel()', () => {
	it('answers the verification challenge when the configured token matches', async () => {
		const webhook = vi.fn();
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_lilac',
			verifyToken: 'verify_token_lilac',
			webhook,
		});
		const app = channelApp(whatsapp);

		const accepted = await app.request(
			'https://example.test/webhook?hub.mode=subscribe&hub.challenge=challenge-841&hub.verify_token=verify_token_lilac',
		);
		const rejected = await app.request(
			'https://example.test/webhook?hub.mode=subscribe&hub.challenge=challenge-841&hub.verify_token=verify_token_changed',
		);
		const duplicated = await app.request(
			'https://example.test/webhook?hub.mode=subscribe&hub.challenge=one&hub.challenge=two&hub.verify_token=verify_token_lilac',
		);

		expect(accepted.status).toBe(200);
		expect(await accepted.text()).toBe('challenge-841');
		expect(accepted.headers.get('content-type')).toBe('text/plain; charset=UTF-8');
		expect(rejected.status).toBe(403);
		expect(duplicated.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('forwards a signed batch of native messages, statuses, and changes unmodified', async () => {
		const webhook = vi.fn();
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_cedar',
			verifyToken: 'verify_token_cedar',
			webhook,
		});
		const raw: WhatsAppWebhookPayload = {
			object: 'whatsapp_business_account',
			entry: [
				{
					id: 'waba_8202',
					changes: [
						{
							field: 'messages',
							value: {
								messaging_product: 'whatsapp',
								metadata: {
									display_phone_number: '+1 555 700 9202',
									phone_number_id: 'phone_9202',
								},
								contacts: [
									{
										wa_id: '+15557001414',
										user_id: 'US.synthetic-amber-14',
										profile: { name: 'Amber Quill' },
									},
								],
								messages: [
									{
										timestamp: '1781200101',
										type: 'text',
										id: 'wamid_text_cedar',
										from: '+15557001414',
										from_user_id: 'US.synthetic-amber-14',
										text: { body: 'Please inspect the edge cache.' },
										context: { forwarded: true },
									},
									{
										id: 'wamid_choice_cedar',
										from: '+15557001414',
										from_user_id: 'US.synthetic-amber-14',
										timestamp: '1781200102',
										type: 'interactive',
										group_id: 'group_ops_cedar',
										interactive: {
											type: 'list_reply',
											list_reply: {
												id: 'region_west',
												title: 'West region',
												description: 'Oregon and Washington',
											},
										},
									},
								],
								statuses: [
									{
										id: 'wamid_outbound_cedar',
										status: 'delivered',
										timestamp: '1781200103',
										recipient_id: '+15557001414',
										recipient_user_id: 'US.synthetic-amber-14',
										biz_opaque_callback_data: 'ticket_778',
										conversation: {
											id: 'conversation_cedar',
											origin: { type: 'service' },
										},
									},
								],
							},
						},
						{
							field: 'messages',
							value: {
								messaging_product: 'whatsapp',
								metadata: {
									display_phone_number: '+1 555 700 9202',
									phone_number_id: 'phone_9202',
								},
								statuses: [],
							},
						},
					],
				},
			],
		};

		const response = await channelApp(whatsapp).request(
			await signedRequest(raw, 'app_secret_cedar'),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		const input = webhook.mock.calls[0]?.[0];
		expect(input.c).toEqual(expect.any(Object));
		// The provider-native payload is forwarded with original field names,
		// nesting, and discriminants, byte-for-byte equal to the signed JSON.
		expect(input.payload).toEqual(raw);
		const change = input.payload.entry[0].changes[0];
		expect(change.field).toBe('messages');
		expect(change.value.messages[0]).toMatchObject({
			type: 'text',
			text: { body: 'Please inspect the edge cache.' },
		});
		expect(change.value.messages[1]).toMatchObject({
			type: 'interactive',
			group_id: 'group_ops_cedar',
			interactive: { type: 'list_reply', list_reply: { id: 'region_west' } },
		});
		expect(change.value.statuses[0]).toMatchObject({
			status: 'delivered',
			recipient_user_id: 'US.synthetic-amber-14',
			conversation: { origin: { type: 'service' } },
		});
	});

	it('forwards BSUID-only messages and statuses when phone numbers are omitted', async () => {
		const webhook = vi.fn();
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_bsuid',
			verifyToken: 'verify_token_bsuid',
			webhook,
		});
		const raw: WhatsAppWebhookPayload = {
			object: 'whatsapp_business_account',
			entry: [
				{
					id: 'waba_8252',
					changes: [
						{
							field: 'messages',
							value: {
								messaging_product: 'whatsapp',
								metadata: {
									display_phone_number: '+1 555 700 9252',
									phone_number_id: 'phone_9252',
								},
								contacts: [
									{
										profile: {
											name: 'Sora Vale',
											username: 'sora.synthetic',
										},
										user_id: 'US.synthetic-user-8252',
										parent_user_id: 'US.ENT.synthetic-parent-8252',
									},
								],
								messages: [
									{
										id: 'wamid_bsuid_message',
										from_user_id: 'US.synthetic-user-8252',
										from_parent_user_id: 'US.ENT.synthetic-parent-8252',
										timestamp: '1781200151',
										type: 'text',
										text: { body: 'Phone number intentionally unavailable.' },
									},
								],
								statuses: [
									{
										id: 'wamid_bsuid_status',
										status: 'delivered',
										timestamp: '1781200152',
										recipient_user_id: 'US.synthetic-user-8252',
										recipient_parent_user_id: 'US.ENT.synthetic-parent-8252',
									},
								],
							},
						},
					],
				},
			],
		};

		const response = await channelApp(whatsapp).request(
			await signedRequest(raw, 'app_secret_bsuid'),
		);

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		const value = webhook.mock.calls[0]?.[0].payload.entry[0].changes[0].value;
		expect(value.contacts[0]).toMatchObject({
			user_id: 'US.synthetic-user-8252',
			parent_user_id: 'US.ENT.synthetic-parent-8252',
			profile: { name: 'Sora Vale', username: 'sora.synthetic' },
		});
		expect(value.messages[0]).toMatchObject({
			from_user_id: 'US.synthetic-user-8252',
			from_parent_user_id: 'US.ENT.synthetic-parent-8252',
		});
		expect(value.messages[0].from).toBeUndefined();
		expect(value.statuses[0]).toMatchObject({
			recipient_user_id: 'US.synthetic-user-8252',
			recipient_parent_user_id: 'US.ENT.synthetic-parent-8252',
		});
	});

	it('forwards media, location, contacts, reactions, and unknown future message families', async () => {
		const webhook = vi.fn();
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_maple',
			verifyToken: 'verify_token_maple',
			webhook,
		});
		const raw = {
			object: 'whatsapp_business_account',
			entry: [
				{
					id: 'waba_8303',
					changes: [
						{
							field: 'messages',
							value: {
								messaging_product: 'whatsapp',
								metadata: {
									display_phone_number: '+1 555 703 9303',
									phone_number_id: 'phone_9303',
								},
								messages: [
									{
										id: 'wamid_image_maple',
										from: '+15557033001',
										timestamp: '1781200201',
										type: 'image',
										image: {
											id: 'media_image_maple',
											mime_type: 'image/webp',
											sha256: 'synthetic-hash-maple',
											caption: 'Damaged package',
										},
									},
									{
										id: 'wamid_location_maple',
										from: '+15557033001',
										timestamp: '1781200202',
										type: 'location',
										location: {
											latitude: 45.5231,
											longitude: -122.6765,
											name: 'Warehouse North',
											address: '88 River Lane',
										},
									},
									{
										id: 'wamid_contacts_maple',
										from: '+15557033001',
										timestamp: '1781200203',
										type: 'contacts',
										contacts: [
											{
												name: {
													formatted_name: 'Mira Stone',
													first_name: 'Mira',
													last_name: 'Stone',
												},
												phones: [{ phone: '+15557039991', wa_id: 'user_mira_991', type: 'WORK' }],
												emails: [{ email: 'mira@example.test', type: 'WORK' }],
												org: { company: 'Northwind Repair' },
											},
										],
									},
									{
										id: 'wamid_reaction_maple',
										from: '+15557033001',
										timestamp: '1781200204',
										type: 'reaction',
										reaction: { message_id: 'wamid_target_maple', emoji: '✅' },
									},
									{
										id: 'wamid_unsupported_maple',
										from: '+15557033001',
										timestamp: '1781200207',
										type: 'unsupported',
										unsupported: { type: 'poll_creation' },
										errors: [
											{
												code: 131051,
												title: 'Synthetic unsupported type',
												error_data: { details: 'Not exposed by this API version.' },
											},
										],
									},
									{
										id: 'wamid_future_maple',
										from: '+15557033001',
										timestamp: '1781200208',
										type: 'future_message',
										future_message: { value: 7 },
									},
								],
							},
						},
					],
				},
			],
		};

		const response = await channelApp(whatsapp).request(
			await signedRequest(raw, 'app_secret_maple'),
		);

		expect(response.status).toBe(200);
		const messages = webhook.mock.calls[0]?.[0].payload.entry[0].changes[0].value.messages;
		expect(messages).toHaveLength(6);
		// Native media payloads keep the bearer-authenticated media id and hash.
		expect(messages[0]).toMatchObject({
			type: 'image',
			image: {
				id: 'media_image_maple',
				sha256: 'synthetic-hash-maple',
				caption: 'Damaged package',
			},
		});
		expect(messages[1]).toMatchObject({
			type: 'location',
			location: { latitude: 45.5231, longitude: -122.6765, name: 'Warehouse North' },
		});
		expect(messages[2].contacts[0]).toMatchObject({
			name: { formatted_name: 'Mira Stone' },
			phones: [{ phone: '+15557039991', wa_id: 'user_mira_991' }],
			org: { company: 'Northwind Repair' },
		});
		expect(messages[3]).toMatchObject({ type: 'reaction', reaction: { emoji: '✅' } });
		expect(messages[4]).toMatchObject({
			type: 'unsupported',
			unsupported: { type: 'poll_creation' },
		});
		// Authenticated future/unmodeled message types are forwarded at runtime.
		expect(messages[5]).toMatchObject({ type: 'future_message', future_message: { value: 7 } });
	});

	it('verifies exact request bytes and forwards any authenticated delivery', async () => {
		const webhook = vi.fn();
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_onyx',
			verifyToken: 'verify_token_onyx',
			webhook,
		});
		const body = ` {\n  "object":"whatsapp_business_account",\n  "entry":[{"id":"waba_8404","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"display_phone_number":"+1 555 704 9404","phone_number_id":"phone_9404"},"messages":[{"id":"wamid_unicode_onyx","from":"+15557044004","from_user_id":"US.synthetic-onyx-04","timestamp":"1781200301","type":"text","text":{"body":"Unicode café"}}]}}]}]\n} `;
		const signature = await hmac('app_secret_onyx', body);
		const app = channelApp(whatsapp);

		const accepted = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-hub-signature-256': `sha256=${signature}`,
				},
				body,
			}),
		);
		const changed = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-hub-signature-256': `sha256=${signature}`,
				},
				body: body.replace('café', 'cafe'),
			}),
		);
		// Identity filtering is now application policy: a delivery for any other
		// business account or phone number is still authenticated and forwarded.
		const otherIdentity = await app.request(
			await signedRequest(
				{
					object: 'whatsapp_business_account',
					entry: [
						{
							id: 'waba_other',
							changes: [
								{
									field: 'messages',
									value: {
										messaging_product: 'whatsapp',
										metadata: {
											display_phone_number: '+1 555 000 0000',
											phone_number_id: 'phone_other',
										},
										messages: [],
									},
								},
							],
						},
					],
				},
				'app_secret_onyx',
			),
		);

		expect(accepted.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(otherIdentity.status).toBe(200);
		expect(webhook).toHaveBeenCalledTimes(2);
	});

	it('rejects malformed requests before invoking application code', async () => {
		const webhook = vi.fn();
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_fir',
			verifyToken: 'verify_token_fir',
			bodyLimit: 160,
			webhook,
		});
		const app = channelApp(whatsapp);

		const wrongContentType = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'text/plain',
					'x-hub-signature-256': `sha256=${'0'.repeat(64)}`,
				},
				body: '{}',
			}),
		);
		const missingSignature = await app.request(
			new Request('https://example.test/webhook', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: '{}',
			}),
		);
		const malformed = await app.request(await signedTextRequest('{"object":', 'app_secret_fir'));
		const oversized = await app.request(
			await signedTextRequest(`{"padding":"${'x'.repeat(200)}"}`, 'app_secret_fir'),
		);
		const malformedEnvelope = await app.request(
			await signedRequest({ object: 'whatsapp_business_account', entry: {} }, 'app_secret_fir'),
		);

		expect(wrongContentType.status).toBe(415);
		expect(missingSignature.status).toBe(401);
		expect(malformed.status).toBe(400);
		expect(oversized.status).toBe(413);
		expect(malformedEnvelope.status).toBe(400);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('uses normal JSON and Hono response behavior and lets handler errors fall through', async () => {
		const raw = {
			object: 'whatsapp_business_account',
			entry: [],
		};
		const empty = createWhatsAppChannel({
			appSecret: 'app_secret_response',
			verifyToken: 'verify_token_response',
			webhook() {},
		});
		const json = createWhatsAppChannel({
			appSecret: 'app_secret_response',
			verifyToken: 'verify_token_response',
			webhook() {
				return { accepted: true };
			},
		});
		const hono = createWhatsAppChannel({
			appSecret: 'app_secret_response',
			verifyToken: 'verify_token_response',
			webhook({ c }) {
				return c.json({ queued: true }, 202);
			},
		});
		const throws = createWhatsAppChannel({
			appSecret: 'app_secret_response',
			verifyToken: 'verify_token_response',
			webhook() {
				throw new Error('synthetic handler failure');
			},
		});

		const emptyResponse = await channelApp(empty).request(
			await signedRequest(raw, 'app_secret_response'),
		);
		const jsonResponse = await channelApp(json).request(
			await signedRequest(raw, 'app_secret_response'),
		);
		const honoResponse = await channelApp(hono).request(
			await signedRequest(raw, 'app_secret_response'),
		);
		const thrownResponse = await channelApp(throws).request(
			await signedRequest(raw, 'app_secret_response'),
		);

		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.text()).toBe('');
		expect(jsonResponse.status).toBe(200);
		expect(await jsonResponse.json()).toEqual({ accepted: true });
		expect(honoResponse.status).toBe(202);
		expect(await honoResponse.json()).toEqual({ queued: true });
		// A thrown handler is not swallowed; it reaches Hono's error handler.
		expect(thrownResponse.status).toBe(500);
	});

	it('round-trips collision-safe phone, BSUID, and group conversation keys', () => {
		const whatsapp = createWhatsAppChannel({
			appSecret: 'app_secret_keys',
			verifyToken: 'verify_token_keys',
			webhook() {},
		});
		const phone: WhatsAppConversationRef = {
			type: 'individual',
			businessAccountId: 'waba:with/slash',
			phoneNumberId: 'phone number 77',
			destination: {
				type: 'phone-number',
				phoneNumber: 'same:destination/77',
			},
		};
		const userId: WhatsAppConversationRef = {
			type: 'individual',
			businessAccountId: 'waba:with/slash',
			phoneNumberId: 'phone number 77',
			destination: {
				type: 'user-id',
				userId: 'same:destination/77',
			},
		};
		const group: WhatsAppConversationRef = {
			type: 'group',
			businessAccountId: 'waba:with/slash',
			phoneNumberId: 'phone number 77',
			groupId: 'group:west/7',
		};

		const phoneKey = whatsapp.conversationKey(phone);
		const userIdKey = whatsapp.conversationKey(userId);
		const groupKey = whatsapp.conversationKey(group);

		expect(phoneKey).not.toBe(userIdKey);
		expect(whatsapp.parseConversationKey(phoneKey)).toEqual(phone);
		expect(whatsapp.parseConversationKey(userIdKey)).toEqual(userId);
		expect(whatsapp.parseConversationKey(groupKey)).toEqual(group);
		expect(() => whatsapp.parseConversationKey(`${phoneKey}%2f`)).toThrow(
			InvalidWhatsAppConversationKeyError,
		);
		expect(() =>
			whatsapp.conversationKey({
				...userId,
				destination: {
					type: 'user-id',
					userId: ' spaced ',
				},
			}),
		).toThrow(InvalidWhatsAppInputError);
	});

	it('validates constructor options without invoking the handler', () => {
		const webhook = vi.fn();

		expect(() =>
			createWhatsAppChannel({
				appSecret: '',
				verifyToken: 'token',
				webhook,
			}),
		).toThrow(InvalidWhatsAppInputError);
		expect(() =>
			createWhatsAppChannel({
				appSecret: 'secret',
				verifyToken: 'token',
				bodyLimit: 0,
				webhook,
			}),
		).toThrow(TypeError);
		expect(webhook).not.toHaveBeenCalled();
	});
});

function channelApp(channel: WhatsAppChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) {
		app.on(route.method, route.path, route.handler);
	}
	return app;
}

async function signedRequest(value: unknown, secret: string): Promise<Request> {
	return signedTextRequest(JSON.stringify(value), secret);
}

async function signedTextRequest(body: string, secret: string): Promise<Request> {
	const signature = await hmac(secret, body);
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'x-hub-signature-256': `sha256=${signature}`,
		},
		body,
	});
}

async function hmac(secret: string, body: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const signature = new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(body)));
	return Array.from(signature, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
