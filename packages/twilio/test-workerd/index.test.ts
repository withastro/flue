import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import { createTwilioChannel } from '../src/index.ts';

const encoder = new TextEncoder();

describe('@flue/twilio workerd ingress', () => {
	it('validates HMAC-SHA1 forms and forwards native SMS fields in workerd', async () => {
		const webhook = vi.fn();
		const channel = createTwilioChannel({
			accountSid: 'AC10101010101010101010101010101010',
			authToken: 'worker-auth-token',
			webhookUrl: 'https://public.example.test/channels/twilio/webhook',
			destination: { type: 'address', address: '+15557014014' },
			webhook,
		});
		const app = new Hono();
		for (const route of channel.routes) {
			app.on(route.method, `/channels/twilio${route.path}`, route.handler);
		}
		const params = new URLSearchParams([
			['MessageSid', 'SM20202020202020202020202020202020'],
			['AccountSid', 'AC10101010101010101010101010101010'],
			['From', '+15557015015'],
			['To', '+15557014014'],
			['Body', 'Worker SMS'],
			['NumMedia', '0'],
			['NumSegments', '1'],
		]);
		const signature = await signatureFor(
			'worker-auth-token',
			'https://public.example.test/channels/twilio/webhook',
			params,
		);

		const accepted = await app.request(
			new Request('https://internal.example.test/channels/twilio/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'x-twilio-signature': signature,
				},
				body: params,
			}),
		);
		const changed = new URLSearchParams(params);
		changed.set('Body', 'Changed SMS');
		const rejected = await app.request(
			new Request('https://internal.example.test/channels/twilio/webhook', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-www-form-urlencoded',
					'x-twilio-signature': signature,
				},
				body: changed,
			}),
		);

		expect(accepted.status).toBe(200);
		expect(await accepted.text()).toContain('<Response/>');
		expect(rejected.status).toBe(401);
		expect(webhook).toHaveBeenCalledOnce();
		const input = webhook.mock.calls[0]?.[0];
		expect(input.payload).toMatchObject({
			MessageSid: 'SM20202020202020202020202020202020',
			Body: 'Worker SMS',
			From: '+15557015015',
			To: '+15557014014',
		});
		expect(input.conversation).toMatchObject({
			type: 'address',
			address: '+15557014014',
			participant: '+15557015015',
		});
	});
});

async function signatureFor(
	authToken: string,
	url: string,
	params: URLSearchParams,
): Promise<string> {
	const values = new Map<string, string[]>();
	for (const [name, value] of params) {
		const existing = values.get(name);
		if (existing) existing.push(value);
		else values.set(name, [value]);
	}
	let data = url;
	for (const name of [...values.keys()].sort()) {
		for (const value of [...new Set(values.get(name) ?? [])].sort()) {
			data += `${name}${value}`;
		}
	}
	const key = await crypto.subtle.importKey(
		'raw',
		encoder.encode(authToken),
		{ name: 'HMAC', hash: 'SHA-1' },
		false,
		['sign'],
	);
	const signed = new Uint8Array(
		await crypto.subtle.sign('HMAC', key, encoder.encode(data)),
	);
	let binary = '';
	for (const byte of signed) binary += String.fromCharCode(byte);
	return btoa(binary);
}
