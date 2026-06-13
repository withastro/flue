import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import {
	createDiscordChannel,
	DiscordApiError,
	DiscordRateLimitError,
	DiscordTimeoutError,
	DuplicateDiscordHandlerError,
	InvalidDiscordConversationKeyError,
	InvalidDiscordInputError,
} from '../src/index.ts';

const encoder = new TextEncoder();
const keyPair = (await crypto.subtle.generateKey(
	{ name: 'Ed25519' },
	true,
	['sign', 'verify'],
)) as CryptoKeyPair;
const publicKey = toHex(new Uint8Array(await crypto.subtle.exportKey('raw', keyPair.publicKey)));

describe('createDiscordChannel()', () => {
	it('returns PONG when a signed PING interaction is valid', async () => {
		const discord = createChannel();

		const response = await discord.routes.interactions()(
			await signedRequest({ type: 1 }),
		);

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ type: 1 });
	});

	it('invokes a command handler with a normalized guild-channel envelope', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'Accepted.' },
			ephemeral: true,
		}));
		discord.onCommand('ask', handler);
		const raw = commandInteraction({
			channel: { id: 'C1', type: 0 },
			data: { type: 1, name: 'ask', options: [{ name: 'question', value: 'hello' }] },
		});

		const response = await discord.routes.interactions()(await signedRequest(raw));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: 4,
			data: { content: 'Accepted.', allowed_mentions: { parse: [] }, flags: 64 },
		});
		expect(handler).toHaveBeenCalledWith({
			id: 'I1',
			applicationId: 'A1',
			token: 'interaction-token',
			destination: {
				type: 'guild',
				guildId: 'G1',
				channelId: 'C1',
				channelKind: 'channel',
			},
			data: {
				name: 'ask',
				options: [{ name: 'question', value: 'hello' }],
			},
			raw,
		});
	});

	it('classifies announcement, public, and private thread interactions as guild threads', async () => {
		for (const channelType of [10, 11, 12]) {
			const discord = createChannel();
			const handler = vi.fn(() => ({
				type: 'message' as const,
				message: { content: 'ok' },
			}));
			discord.onCommand('ask', handler);

			const response = await discord.routes.interactions()(
				await signedRequest(
					commandInteraction({
						channel_id: 'T1',
						channel: { id: 'T1', type: channelType },
					}),
				),
			);

			expect(response.status).toBe(200);
			const interaction = (handler.mock.calls as unknown[][])[0]?.[0] as {
				destination: unknown;
			};
			expect(interaction.destination).toEqual({
				type: 'guild',
				guildId: 'G1',
				channelId: 'T1',
				channelKind: 'thread',
			});
		}
	});

	it('invokes a command handler for a bot-DM interaction', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		discord.onCommand('ask', handler);

		const response = await discord.routes.interactions()(
			await signedRequest(
				commandInteraction({
					guild_id: undefined,
					context: 1,
					channel: { id: 'D1', type: 1 },
					channel_id: 'D1',
				}),
			),
		);

		expect(response.status).toBe(200);
		const interaction = (handler.mock.calls as unknown[][])[0]?.[0] as {
			destination: unknown;
		};
		expect(interaction.destination).toEqual({ type: 'dm', channelId: 'D1' });
	});

	it('rejects private-channel and group-DM contexts before invoking a handler', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		discord.onCommand('ask', handler);

		const privateChannel = await discord.routes.interactions()(
			await signedRequest(
				commandInteraction({
					guild_id: undefined,
					context: 2,
					channel: { id: 'P1', type: 3 },
					channel_id: 'P1',
				}),
			),
		);
		const groupDm = await discord.routes.interactions()(
			await signedRequest(
				commandInteraction({
					guild_id: undefined,
					context: undefined,
					channel: { id: 'D2', type: 3 },
					channel_id: 'D2',
				}),
			),
		);
		const missingChannelType = await discord.routes.interactions()(
			await signedRequest(
				commandInteraction({
					guild_id: undefined,
					context: 1,
					channel: { id: 'D3' },
					channel_id: 'D3',
				}),
			),
		);
		const mismatchedChannel = await discord.routes.interactions()(
			await signedRequest(
				commandInteraction({
					channel: { id: 'C2', type: 0 },
					channel_id: 'C1',
				}),
			),
		);

		expect(privateChannel.status).toBe(400);
		expect(groupDm.status).toBe(400);
		expect(missingChannelType.status).toBe(400);
		expect(mismatchedChannel.status).toBe(400);
		expect(handler).not.toHaveBeenCalled();
	});

	it('rejects a signed application identity mismatch before invoking a handler', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		discord.onCommand('ask', handler);

		const response = await discord.routes.interactions()(
			await signedRequest(commandInteraction({ application_id: 'A2' })),
		);

		expect(response.status).toBe(403);
		expect(handler).not.toHaveBeenCalled();
	});

	it('snapshots configured application identity when the channel is created', async () => {
		const options = {
			publicKey,
			applicationId: 'A1',
			botToken: 'token',
		};
		const discord = createDiscordChannel(options);
		discord.onCommand('ask', () => ({
			type: 'message',
			message: { content: 'ok' },
		}));
		options.applicationId = 'A2';

		const response = await discord.routes.interactions()(
			await signedRequest(commandInteraction({ application_id: 'A1' })),
		);

		expect(response.status).toBe(200);
	});

	it('serializes component update and modal responses with provider-native field names', async () => {
		const update = createChannel();
		update.onComponent('approve', () => ({
			type: 'update_message',
			message: {
				content: 'Approved',
				components: [
					{
						type: 1,
						components: [{ type: 2, customId: 'done', label: 'Done', style: 1 }],
					},
				],
			},
		}));
		const modal = createChannel();
		modal.onComponent('approve', () => ({
			type: 'modal',
			customId: 'approval_reason',
			title: 'Approval reason',
			components: [
				{
					type: 18,
					label: 'Reason',
					component: { type: 4, customId: 'reason', style: 2 },
				},
			],
		}));
		const raw = componentInteraction();

		const updateResponse = await update.routes.interactions()(await signedRequest(raw));
		const modalResponse = await modal.routes.interactions()(await signedRequest(raw));

		expect(await updateResponse.json()).toEqual({
			type: 7,
			data: {
				content: 'Approved',
				allowed_mentions: { parse: [] },
				components: [
					{
						type: 1,
						components: [{ type: 2, custom_id: 'done', label: 'Done', style: 1 }],
					},
				],
			},
		});
		expect(await modalResponse.json()).toEqual({
			type: 9,
			data: {
				custom_id: 'approval_reason',
				title: 'Approval reason',
				components: [
					{
						type: 18,
						label: 'Reason',
						component: { type: 4, custom_id: 'reason', style: 2 },
					},
				],
			},
		});
	});

	it('invokes a modal handler and serializes a message response', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'Saved.' },
		}));
		discord.onModal('approval_reason', handler);
		const raw = modalInteraction();

		const response = await discord.routes.interactions()(await signedRequest(raw));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			type: 4,
			data: { content: 'Saved.', allowed_mentions: { parse: [] } },
		});
		const interaction = (handler.mock.calls as unknown[][])[0]?.[0] as { data: unknown };
		expect(interaction.data).toEqual({
			customId: 'approval_reason',
			components: [
				{
					type: 18,
					component: { type: 4, custom_id: 'reason', value: '' },
				},
			],
			fields: [{ customId: 'reason', type: 4, value: '' }],
		});
	});

	it('rejects non-chat-input commands and non-button components before handler lookup', async () => {
		const command = createChannel();
		const commandHandler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		command.onCommand('ask', commandHandler);
		const component = createChannel();
		const componentHandler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		component.onComponent('choose', componentHandler);

		const contextCommand = await command.routes.interactions()(
			await signedRequest(commandInteraction({ data: { type: 2, name: 'ask' } })),
		);
		const select = await component.routes.interactions()(
			await signedRequest(
				componentInteraction({
					data: { custom_id: 'choose', component_type: 3, values: ['one'] },
				}),
			),
		);

		expect(contextCommand.status).toBe(400);
		expect(select.status).toBe(400);
		expect(commandHandler).not.toHaveBeenCalled();
		expect(componentHandler).not.toHaveBeenCalled();
	});

	it('returns failure when an interaction handler is missing, throws, times out, or responds invalidly', async () => {
		const missing = createChannel();
		const throwing = createChannel();
		throwing.onCommand('ask', () => {
			throw new Error('dispatch failed');
		});
		const slow = createChannel();
		slow.onCommand('ask', async () => {
			await new Promise((resolve) => setTimeout(resolve, 30));
			return { type: 'message', message: { content: 'late' } };
		});
		const invalid = createChannel();
		invalid.onCommand('ask', () => ({ type: 'message', message: { content: '' } }));
		const invalidButton = createChannel();
		invalidButton.onCommand('ask', () => ({
			type: 'message',
			message: {
				content: 'Choose',
				components: [
					{
						type: 1,
						components: [
							{
								type: 2,
								customId: 'choose',
								label: 'Choose',
								style: 1,
								value: 'unsupported',
							},
						],
					},
				],
			},
		}));
		const invalidModal = createChannel();
		invalidModal.onCommand('ask', () => ({
			type: 'modal',
			customId: 'reason',
			title: 'Reason',
			components: [{ type: 1, components: [] }],
		}));
		const request = () => signedRequest(commandInteraction());

		const missingResponse = await missing.routes.interactions()(await request());
		const throwingResponse = await throwing.routes.interactions()(await request());
		const slowResponse = await slow.routes.interactions({ handlerTimeoutMs: 5 })(
			await request(),
		);
		const invalidResponse = await invalid.routes.interactions()(await request());
		const invalidButtonResponse = await invalidButton.routes.interactions()(await request());
		const invalidModalResponse = await invalidModal.routes.interactions()(await request());

		expect(missingResponse.status).toBe(404);
		expect(throwingResponse.status).toBe(500);
		expect(slowResponse.status).toBe(500);
		expect(invalidResponse.status).toBe(500);
		expect(invalidButtonResponse.status).toBe(500);
		expect(invalidModalResponse.status).toBe(500);
	});

	it('invokes a handler again when an identical valid interaction is replayed', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		discord.onCommand('ask', handler);
		const raw = commandInteraction();

		const first = await discord.routes.interactions()(await signedRequest(raw));
		const second = await discord.routes.interactions()(await signedRequest(raw));

		expect(first.status).toBe(200);
		expect(second.status).toBe(200);
		expect(handler).toHaveBeenCalledTimes(2);
	});

	it('rejects missing, malformed, wrong-length, and invalid signatures', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		discord.onCommand('ask', handler);
		const body = JSON.stringify(commandInteraction());
		const valid = await signedRequest(commandInteraction());
		const signature = valid.headers.get('x-signature-ed25519') ?? '';
		const timestamp = valid.headers.get('x-signature-timestamp') ?? '';

		const missing = await discord.routes.interactions()(
			new Request('https://example.test/', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body,
			}),
		);
		const malformed = await discord.routes.interactions()(
			new Request('https://example.test/', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-signature-ed25519': 'zz',
					'x-signature-timestamp': timestamp,
				},
				body,
			}),
		);
		const wrongLength = await discord.routes.interactions()(
			new Request('https://example.test/', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-signature-ed25519': signature.slice(2),
					'x-signature-timestamp': timestamp,
				},
				body,
			}),
		);
		const invalid = await discord.routes.interactions()(
			new Request('https://example.test/', {
				method: 'POST',
				headers: {
					'content-type': 'application/json',
					'x-signature-ed25519': signature,
					'x-signature-timestamp': `${timestamp}0`,
				},
				body,
			}),
		);

		expect(missing.status).toBe(401);
		expect(malformed.status).toBe(401);
		expect(wrongLength.status).toBe(401);
		expect(invalid.status).toBe(401);
		expect(handler).not.toHaveBeenCalled();
	});

	it('verifies the exact non-canonical UTF-8 JSON bytes', async () => {
		const discord = createChannel();
		const handler = vi.fn(() => ({
			type: 'message' as const,
			message: { content: 'ok' },
		}));
		discord.onCommand('ask', handler);
		const raw = commandInteraction({
			data: { type: 1, name: 'ask', options: [{ value: 'café' }] },
		});
		const body = ` {\n "type": 2,\n "id":"I1", "application_id":"A1", "token":"interaction-token",\n "guild_id":"G1", "context":0, "channel_id":"C1", "channel":{"id":"C1","type":0},\n "data":{"type":1,"name":"ask","options":[{"value":"café"}]}\n} `;
		const request = await signedRequest(raw, { body });

		const valid = await discord.routes.interactions()(request);
		const changed = await discord.routes.interactions()(
			new Request('https://example.test/', {
				method: 'POST',
				headers: request.headers,
				body: body.replace('café', 'cafe'),
			}),
		);

		expect(valid.status).toBe(200);
		expect(changed.status).toBe(401);
		expect(handler).toHaveBeenCalledOnce();
	});

	it('enforces route method, path, content type, body state, and size contracts', async () => {
		const discord = createChannel();
		const handler = discord.routes.interactions({ bodyLimit: 128 });
		const getResponse = await handler(new Request('https://example.test/', { method: 'GET' }));
		const nestedResponse = await handler(
			new Request('https://example.test/nested', { method: 'POST' }),
		);
		const contentTypeResponse = await handler(
			new Request('https://example.test/', {
				method: 'POST',
				headers: { 'content-type': 'text/plain' },
				body: '{}',
			}),
		);
		const oversizedDeclared = await handler(
			new Request('https://example.test/', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'content-length': '129' },
				body: '{}',
			}),
		);
		const oversizedActual = await handler(
			await signedRequest(commandInteraction({ padding: 'x'.repeat(200) })),
		);
		const consumed = await signedRequest(commandInteraction());
		await consumed.text();
		const consumedResponse = await handler(consumed);

		expect(getResponse.status).toBe(405);
		expect(getResponse.headers.get('allow')).toBe('POST');
		expect(nestedResponse.status).toBe(404);
		expect(contentTypeResponse.status).toBe(415);
		expect(oversizedDeclared.status).toBe(413);
		expect(oversizedActual.status).toBe(413);
		expect(consumedResponse.status).toBe(400);
	});

	it('returns independently mountable unbound handlers for repeated route factories', async () => {
		const discord = createChannel();
		const first = discord.routes.interactions();
		const second = discord.routes.interactions();
		const app = new Hono();
		app.mount('/webhooks/discord', first);

		const mounted = await app.request(
			await signedRequest({ type: 1 }, {
				url: 'https://example.test/webhooks/discord?source=test',
			}),
		);
		const direct = await second(await signedRequest({ type: 1 }));

		expect(first).not.toBe(second);
		expect(mounted.status).toBe(200);
		expect(direct.status).toBe(200);
	});

	it('rejects invalid route options when a route is created', () => {
		const discord = createChannel();

		expect(() => discord.routes.interactions({ bodyLimit: 0 })).toThrow(TypeError);
		expect(() => discord.routes.interactions({ handlerTimeoutMs: 0 })).toThrow(TypeError);
		expect(() => discord.routes.interactions({ handlerTimeoutMs: 2_501 })).toThrow(TypeError);
	});

	it('rejects duplicate owners and supports registration-specific idempotent unsubscribe', () => {
		const discord = createChannel();
		const unsubscribe = discord.onCommand('ask', () => ({
			type: 'message',
			message: { content: 'ok' },
		}));

		expect(() =>
			discord.onCommand('ask', () => ({
				type: 'message',
				message: { content: 'again' },
			})),
		).toThrow(DuplicateDiscordHandlerError);
		expect(unsubscribe()).toBe(true);
		expect(unsubscribe()).toBe(false);
		expect(() =>
			discord.onCommand('ask', () => ({
				type: 'message',
				message: { content: 'replacement' },
			})),
		).not.toThrow();
	});

	it('round-trips canonical destination keys and rejects malformed or non-canonical keys', () => {
		const discord = createChannel();
		const refs = [
			{ type: 'guild', guildId: 'g:1', channelId: 'c/2', channelKind: 'channel' },
			{ type: 'guild', guildId: 'g:1', channelId: 't:3', channelKind: 'thread' },
			{ type: 'dm', channelId: 'd:4' },
		] as const;

		for (const ref of refs) {
			expect(discord.parseConversationKey(discord.conversationKey(ref))).toEqual(ref);
		}
		expect(() => discord.parseConversationKey('discord:v1:dm:d%2f4')).toThrow(
			InvalidDiscordConversationKeyError,
		);
		expect(() => discord.parseConversationKey('slack:v1:x')).toThrow(
			InvalidDiscordConversationKeyError,
		);
	});

	it('validates configured credentials, destinations, registration keys, and timeouts', () => {
		expect(() =>
			createDiscordChannel({ publicKey: 'key', applicationId: 'A1', botToken: 'token' }),
		).toThrow(InvalidDiscordInputError);
		expect(() =>
			createDiscordChannel({
				publicKey,
				applicationId: 'A1',
				botToken: 'token',
				requestTimeoutMs: 0,
			}),
		).toThrow(InvalidDiscordInputError);
		const discord = createChannel();
		expect(() => discord.onCommand('', () => ({ type: 'message', message: { content: 'x' } }))).toThrow(
			InvalidDiscordInputError,
		);
		expect(() =>
			discord.conversationKey({
				type: 'guild',
				guildId: '',
				channelId: 'C1',
				channelKind: 'channel',
			}),
		).toThrow(InvalidDiscordInputError);
	});

	it('posts an authenticated provider-native message to the bound channel', async () => {
		const fetch = vi.fn(async () => Response.json({ id: 'M1' }));
		const discord = createChannel({ fetch });

		await discord.client.postMessage(
			{ type: 'guild', guildId: 'G1', channelId: 'C/1', channelKind: 'thread' },
			{
				content: 'hello',
				components: [
					{
						type: 1,
						components: [
							{ type: 2, customId: 'approve', label: 'Approve', style: 3 },
						],
					},
				],
				allowedMentions: { parse: [], users: ['U1'] },
			},
		);

		expect(fetch).toHaveBeenCalledOnce();
		const [url, init] = (fetch.mock.calls as unknown[][])[0] as [URL, RequestInit];
		expect(String(url)).toBe('https://discord.com/api/v10/channels/C%2F1/messages');
		expect(init).toMatchObject({
			method: 'POST',
			redirect: 'manual',
			headers: {
				Accept: 'application/json',
				Authorization: 'Bot token',
				'Content-Type': 'application/json',
				'User-Agent': '@flue/discord',
			},
		});
		expect(JSON.parse(String(init.body))).toEqual({
			content: 'hello',
			components: [
				{
					type: 1,
					components: [
						{ type: 2, custom_id: 'approve', label: 'Approve', style: 3 },
					],
				},
			],
			allowed_mentions: { parse: [], users: ['U1'] },
		});
	});

	it('rejects unsupported message component fields before an authenticated request', async () => {
		const fetch = vi.fn(async () => Response.json({ id: 'M1' }));
		const discord = createChannel({ fetch });

		await expect(
			discord.client.postMessage(
				{ type: 'dm', channelId: 'C1' },
				{
					content: 'Choose',
					components: [
						{
							type: 1,
							components: [
								{
									type: 2,
									customId: 'approve',
									label: 'Approve',
									style: 3,
									value: 'not-a-discord-button-field',
								},
							],
						},
					],
				},
			),
		).rejects.toBeInstanceOf(InvalidDiscordInputError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it('disables parsed mentions by default for direct client posts', async () => {
		const fetch = vi.fn(async () => Response.json({ id: 'M1' }));
		const discord = createChannel({ fetch });

		await discord.client.postMessage(
			{ type: 'dm', channelId: 'C1' },
			{ content: '@everyone' },
		);

		const [, init] = (fetch.mock.calls as unknown[][])[0] as [URL, RequestInit];
		expect(JSON.parse(String(init.body))).toEqual({
			content: '@everyone',
			allowed_mentions: { parse: [] },
		});
	});

	it('follows bounded preserving redirects only on the fixed Discord origin', async () => {
		const allowedFetch = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(null, {
					status: 307,
					headers: { location: '/api/v10/channels/C2/messages' },
				}),
			)
			.mockResolvedValueOnce(Response.json({ id: 'M1' }));
		const allowed = createChannel({ fetch: allowedFetch });

		await allowed.client.postMessage(
			{ type: 'dm', channelId: 'C1' },
			{ content: 'hello' },
		);

		expect(String(allowedFetch.mock.calls[1]?.[0])).toBe(
			'https://discord.com/api/v10/channels/C2/messages',
		);

		for (const location of ['https://evil.test/messages', '//evil.test/messages']) {
			const fetch = vi.fn(async () => new Response(null, { status: 307, headers: { location } }));
			const discord = createChannel({ fetch });

			await expect(
				discord.client.postMessage({ type: 'dm', channelId: 'C1' }, { content: 'hello' }),
			).rejects.toBeInstanceOf(DiscordApiError);
			expect(fetch).toHaveBeenCalledOnce();
		}
	});

	it('does not replay a write across non-preserving redirects', async () => {
		for (const status of [301, 302, 303]) {
			const fetch = vi.fn(async () =>
				new Response(null, {
					status,
					headers: { location: '/api/v10/channels/C2/messages' },
				}),
			);
			const discord = createChannel({ fetch });

			await expect(
				discord.client.postMessage({ type: 'dm', channelId: 'C1' }, { content: 'hello' }),
			).rejects.toBeInstanceOf(DiscordApiError);
			expect(fetch).toHaveBeenCalledOnce();
		}
	});

	it('surfaces bounded redacted provider and structured rate-limit errors', async () => {
		const provider = createChannel({
			fetch: vi.fn(async () =>
				Response.json(
					{ code: 50_013, message: `Missing permissions for token ${'token'}${'x'.repeat(2_000)}` },
					{
						status: 403,
						headers: { 'x-discord-request-id': 'R1' },
					},
				),
			),
		});
		const limited = createChannel({
			fetch: vi.fn(async () =>
				Response.json(
					{ message: 'You are being rate limited.', retry_after: 1.25, global: true },
					{
						status: 429,
						headers: {
							'x-ratelimit-scope': 'global',
							'x-ratelimit-bucket': 'bucket-1',
						},
					},
				),
			),
		});

		const providerError = await provider.client
			.postMessage({ type: 'dm', channelId: 'C1' }, { content: 'hello' })
			.catch((error: unknown) => error);
		const rateLimitError = await limited.client
			.postMessage({ type: 'dm', channelId: 'C1' }, { content: 'hello' })
			.catch((error: unknown) => error);

		expect(providerError).toBeInstanceOf(DiscordApiError);
		expect(providerError).toMatchObject({
			status: 403,
			code: '50013',
			requestId: 'R1',
		});
		expect((providerError as DiscordApiError).responseMessage).not.toContain('token');
		expect((providerError as DiscordApiError).responseMessage?.length).toBeLessThanOrEqual(
			1_000,
		);
		expect(rateLimitError).toBeInstanceOf(DiscordRateLimitError);
		expect(rateLimitError).toMatchObject({
			status: 429,
			retryAfterSeconds: 1.25,
			global: true,
			rateLimitScope: 'global',
			rateLimitBucket: 'bucket-1',
		});
	});

	it('distinguishes client timeout from caller abort', async () => {
		const fetch = vi.fn(
			async (_url: URL | RequestInfo, init?: RequestInit) =>
				new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
				}),
		);
		const timeout = createChannel({ fetch, requestTimeoutMs: 5 });
		await expect(
			timeout.client.postMessage({ type: 'dm', channelId: 'C1' }, { content: 'hello' }),
		).rejects.toBeInstanceOf(DiscordTimeoutError);

		const controller = new AbortController();
		const callerAbort = createChannel({ fetch, requestTimeoutMs: 1_000 });
		const promise = callerAbort.client.postMessage(
			{ type: 'dm', channelId: 'C1' },
			{ content: 'hello' },
			controller.signal,
		);
		controller.abort(new Error('caller stopped'));
		await expect(promise).rejects.toThrow('caller stopped');
	});

	it('disables mention parsing and snapshots the trusted destination in message tools', async () => {
		const discord = createChannel();
		const postMessage = vi.spyOn(discord.client, 'postMessage').mockResolvedValue();
		const ref = {
			type: 'guild' as const,
			guildId: 'G1',
			channelId: 'C1',
			channelKind: 'channel' as const,
		};
		const tool = discord.tools.postMessage(ref);
		ref.channelId = 'C2';

		await tool.execute({ text: '@everyone' });

		expect(postMessage).toHaveBeenCalledWith(
			{ type: 'guild', guildId: 'G1', channelId: 'C1', channelKind: 'channel' },
			{ content: '@everyone', allowedMentions: { parse: [] } },
			undefined,
		);
		expect(tool.parameters).not.toHaveProperty('properties.channelId');
		expect(tool.parameters).not.toHaveProperty('properties.allowMentions');
	});

	it('enables only trusted mention classes configured when a tool is created', async () => {
		const discord = createChannel();
		const postMessage = vi.spyOn(discord.client, 'postMessage').mockResolvedValue();
		const allowMentions: Array<'users' | 'roles'> = ['users', 'roles'];
		const tool = discord.tools.postMessage(
			{ type: 'dm', channelId: 'D1' },
			{ allowMentions },
		);
		allowMentions.push('users');

		await tool.execute({ text: '<@U1>' });

		expect(postMessage).toHaveBeenCalledWith(
			{ type: 'dm', channelId: 'D1' },
			{ content: '<@U1>', allowedMentions: { parse: ['users', 'roles'] } },
			undefined,
		);
	});
});

function createChannel(
	overrides: Partial<Parameters<typeof createDiscordChannel>[0]> = {},
) {
	return createDiscordChannel({
		publicKey,
		applicationId: 'A1',
		botToken: 'token',
		...overrides,
	});
}

function commandInteraction(overrides: Record<string, unknown> = {}) {
	return {
		type: 2,
		id: 'I1',
		application_id: 'A1',
		token: 'interaction-token',
		guild_id: 'G1',
		context: 0,
		channel_id: 'C1',
		channel: { id: 'C1', type: 0 },
		data: { type: 1, name: 'ask', options: [] },
		...overrides,
	};
}

function componentInteraction(overrides: Record<string, unknown> = {}) {
	return {
		...commandInteraction(),
		type: 3,
		data: { custom_id: 'approve', component_type: 2, values: ['yes'] },
		...overrides,
	};
}

function modalInteraction(overrides: Record<string, unknown> = {}) {
	return {
		...commandInteraction(),
		type: 5,
		data: {
			custom_id: 'approval_reason',
			components: [
				{
					type: 18,
					component: {
						type: 4,
						custom_id: 'reason',
						value: '',
					},
				},
			],
		},
		...overrides,
	};
}

async function signedRequest(
	payload: Record<string, unknown>,
	options: { body?: string; url?: string; timestamp?: string } = {},
): Promise<Request> {
	const body = options.body ?? JSON.stringify(payload);
	const timestamp = options.timestamp ?? '1717971234';
	const signed = new Uint8Array(encoder.encode(timestamp).byteLength + encoder.encode(body).byteLength);
	signed.set(encoder.encode(timestamp));
	signed.set(encoder.encode(body), encoder.encode(timestamp).byteLength);
	const signature = new Uint8Array(
		await crypto.subtle.sign('Ed25519', keyPair.privateKey, signed),
	);
	return new Request(options.url ?? 'https://example.test/', {
		method: 'POST',
		headers: {
			'content-type': 'application/json; charset=utf-8',
			'x-signature-ed25519': toHex(signature),
			'x-signature-timestamp': timestamp,
		},
		body,
	});
}

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}
