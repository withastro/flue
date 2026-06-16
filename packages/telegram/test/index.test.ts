import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createTelegramChannel,
	InvalidTelegramConversationKeyError,
	InvalidTelegramInputError,
	type TelegramChannel,
	type TelegramConversationRef,
} from '../src/index.ts';

describe('createTelegramChannel()', () => {
	it('forwards a verified message update with provider-native fields', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({
			secretToken: 'telegram_secret-42',
			webhook,
		});
		const raw = {
			update_id: 910_201,
			message: {
				message_id: 77,
				date: 1_781_100_001,
				message_thread_id: 314,
				from: {
					id: 883_001,
					is_bot: false,
					first_name: 'Mina',
					last_name: 'Vale',
					username: 'mina_vale',
					language_code: 'en',
				},
				chat: {
					id: -1_001_778_812_345,
					type: 'supergroup',
					title: 'Edge Operations',
				},
				text: '/triage@FieldBot inspect cache headers',
				entities: [{ offset: 0, length: 16, type: 'bot_command' }],
			},
		};

		const response = await channelApp(telegram).request(request(raw, 'telegram_secret-42'));

		expect(response.status).toBe(200);
		expect(webhook).toHaveBeenCalledOnce();
		// The native Update is passed through unmodified, with Telegram's own
		// snake_case field names, nesting, and discriminants.
		expect(webhook.mock.calls[0]?.[0]).toMatchObject({ c: expect.any(Object) });
		expect(webhook.mock.calls[0]?.[0].update).toEqual(raw);
	});

	it('forwards business and channel-post updates with their native discriminants', async () => {
		const updates: unknown[] = [];
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook({ update }) {
				updates.push(update);
			},
		});
		const app = channelApp(telegram);

		const regular = {
			update_id: 1,
			message: {
				message_id: 81,
				date: 1_781_100_010,
				chat: { id: 445_101, type: 'private', first_name: 'Rhea' },
				text: 'regular message',
			},
		};
		const business = {
			update_id: 2,
			business_message: {
				message_id: 82,
				date: 1_781_100_011,
				business_connection_id: 'business-cobalt',
				chat: { id: 445_101, type: 'private', first_name: 'Rhea' },
				text: 'business message',
			},
		};

		expect((await app.request(request(regular, 'secret'))).status).toBe(200);
		expect((await app.request(request(business, 'secret'))).status).toBe(200);
		expect(updates).toEqual([regular, business]);
	});

	it('forwards callback queries, reactions, and an unmodeled update variant unchanged', async () => {
		const seen: unknown[] = [];
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook({ update }) {
				seen.push(update);
			},
		});
		const app = channelApp(telegram);

		const callbackQuery = {
			update_id: 910_204,
			callback_query: {
				id: 'callback-maple',
				from: { id: 700_101, is_bot: false, first_name: 'Noor' },
				chat_instance: 'chat-instance-17',
				data: 'approve:17',
				message: {
					message_id: 106,
					date: 1_781_100_030,
					chat: { id: 552_004, type: 'private', first_name: 'Noor' },
					text: 'Approve the deployment?',
				},
			},
		};
		const reaction = {
			update_id: 910_206,
			message_reaction: {
				chat: { id: -100_778_991, type: 'channel', title: 'Release Notes' },
				message_id: 17,
				date: 1_781_100_040,
				user: { id: 900_002, is_bot: false, first_name: 'Ari' },
				old_reaction: [],
				new_reaction: [{ type: 'emoji', emoji: '👍' }],
			},
		};
		// A future or otherwise unmodeled discriminant is still forwarded so long
		// as the envelope carries a valid update_id.
		const unmodeled = {
			update_id: 910_208,
			shipping_query: { id: 'shipping-saffron', invoice_payload: 'order-204' },
		};

		expect((await app.request(request(callbackQuery, 'secret'))).status).toBe(200);
		expect((await app.request(request(reaction, 'secret'))).status).toBe(200);
		expect((await app.request(request(unmodeled, 'secret'))).status).toBe(200);
		expect(seen).toEqual([callbackQuery, reaction, unmodeled]);
	});

	it('rejects missing or changed secret tokens before application behavior', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({
			secretToken: 'expected_secret',
			webhook,
		});
		const raw = {
			update_id: 1,
			message: {
				message_id: 1,
				date: 1_781_100_050,
				chat: { id: 42, type: 'private', first_name: 'Kai' },
				text: 'hello',
			},
		};
		const app = channelApp(telegram);

		const missing = await app.request(request(raw));
		const changed = await app.request(request(raw, 'expected_secreu'));

		expect(missing.status).toBe(401);
		expect(changed.status).toBe(401);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('rejects wrong content type, malformed envelopes, and oversized bodies', async () => {
		const webhook = vi.fn();
		const telegram = createTelegramChannel({ secretToken: 'secret', webhook });
		const app = channelApp(telegram);

		const wrongContentType = new Request('https://example.test/webhook', {
			method: 'POST',
			headers: {
				'content-type': 'text/plain',
				'x-telegram-bot-api-secret-token': 'secret',
			},
			body: '{}',
		});
		const missingUpdateId = { message: { text: 'no update id' } };
		const negativeUpdateId = { update_id: -1, message: { text: 'bad id' } };
		const notObject = [1, 2, 3];

		expect((await app.request(wrongContentType)).status).toBe(415);
		expect((await app.request(request(missingUpdateId, 'secret'))).status).toBe(400);
		expect((await app.request(request(negativeUpdateId, 'secret'))).status).toBe(400);
		expect((await app.request(request(notObject, 'secret'))).status).toBe(400);

		const limited = createTelegramChannel({
			secretToken: 'secret',
			bodyLimit: 180,
			webhook,
		});
		expect(
			(
				await channelApp(limited).request(
					request(
						{ update_id: 3, poll: { id: 'poll-large', explanation: 'x'.repeat(300) } },
						'secret',
					),
				)
			).status,
		).toBe(413);
		expect(webhook).not.toHaveBeenCalled();
	});

	it('uses empty 200, JSON webhook replies, and Hono responses', async () => {
		const raw = {
			update_id: 5,
			message: {
				message_id: 5,
				date: 5,
				chat: { id: 5, type: 'private', first_name: 'Moe' },
				text: 'response',
			},
		};
		const empty = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => undefined,
		});
		const json = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => ({
				method: 'sendChatAction',
				chat_id: 5,
				action: 'typing',
			}),
		});
		const hono = createTelegramChannel({
			secretToken: 'secret',
			webhook: ({ c }) => c.json({ retry: true }, 503),
		});

		const emptyResponse = await channelApp(empty).request(request(raw, 'secret'));
		const jsonResponse = await channelApp(json).request(request(raw, 'secret'));
		const honoResponse = await channelApp(hono).request(request(raw, 'secret'));

		expect(emptyResponse.status).toBe(200);
		expect(await emptyResponse.text()).toBe('');
		expect(await jsonResponse.json()).toEqual({
			method: 'sendChatAction',
			chat_id: 5,
			action: 'typing',
		});
		expect(honoResponse.status).toBe(503);
	});

	it('returns 500 when application behavior throws, and serializes non-JSON returns', async () => {
		const raw = {
			update_id: 6,
			message: {
				message_id: 6,
				date: 6,
				chat: { id: 6, type: 'private', first_name: 'Sol' },
			},
		};
		const throwing = createTelegramChannel({
			secretToken: 'secret',
			webhook() {
				throw new Error('failed');
			},
		});
		// After serializer alignment with Slack, a non-Response, non-undefined
		// return is handed to `Response.json` unconditionally. Values that
		// `JSON.stringify` accepts serialize and return 200 (a Map becomes `{}`,
		// NaN becomes null); only a value that makes `Response.json` itself throw
		// (e.g. a BigInt) falls through to Hono's framework error handler.
		const mapReturn = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => new Map([['a', 1]]) as never,
		});
		const nanReturn = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => NaN as never,
		});
		const bigintReturn = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => 10n as never,
		});

		expect((await channelApp(throwing).request(request(raw, 'secret'))).status).toBe(500);

		const mapResponse = await channelApp(mapReturn).request(request(raw, 'secret'));
		expect(mapResponse.status).toBe(200);
		expect(await mapResponse.json()).toEqual({});

		const nanResponse = await channelApp(nanReturn).request(request(raw, 'secret'));
		expect(nanResponse.status).toBe(200);
		expect(await nanResponse.json()).toBeNull();

		// `Response.json(10n)` throws synchronously; Hono's default error
		// handler turns the thrown error into a 500.
		expect((await channelApp(bigintReturn).request(request(raw, 'secret'))).status).toBe(500);
	});

	it('round-trips regular, business, thread, and direct-topic conversation keys', () => {
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => undefined,
		});
		const refs: TelegramConversationRef[] = [
			{ type: 'chat' as const, chatId: -1_001_992, messageThreadId: 21 },
			{
				type: 'chat' as const,
				chatId: -1_001_993,
				directMessagesTopicId: 22,
			},
			{
				type: 'business-chat' as const,
				businessConnectionId: 'business:cyan',
				chatId: 998_201,
			},
		];

		for (const ref of refs) {
			const key = telegram.conversationKey(ref);
			expect(telegram.parseConversationKey(key)).toEqual(ref);
		}
		expect(telegram.conversationKey(refs[2] as TelegramConversationRef)).toBe(
			'telegram:v1:business:business%3Acyan:chat:998201:thread::direct:',
		);
	});

	it('rejects non-canonical keys, overlapping topic identity, and invalid setup', () => {
		expect(() =>
			createTelegramChannel({
				secretToken: 'contains space',
				webhook: () => undefined,
			}),
		).toThrow(InvalidTelegramInputError);
		const telegram = createTelegramChannel({
			secretToken: 'secret',
			webhook: () => undefined,
		});
		expect(() =>
			telegram.conversationKey({
				type: 'chat',
				chatId: 1,
				messageThreadId: 2,
				directMessagesTopicId: 3,
			}),
		).toThrow(InvalidTelegramInputError);
		expect(() =>
			telegram.parseConversationKey('telegram:v1:regular:chat:01:thread::direct:'),
		).toThrow(InvalidTelegramConversationKeyError);
		expect(telegram.routes).toHaveLength(1);
		expect(telegram.routes[0]).toMatchObject({
			method: 'POST',
			path: '/webhook',
		});
	});
});

function channelApp(channel: TelegramChannel): Hono {
	const app = new Hono();
	for (const route of channel.routes) app.on(route.method, route.path, route.handler);
	return app;
}

function request(value: unknown, secret?: string): Request {
	return new Request('https://example.test/webhook', {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			...(secret === undefined ? {} : { 'x-telegram-bot-api-secret-token': secret }),
		},
		body: JSON.stringify(value),
	});
}
