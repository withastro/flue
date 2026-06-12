import { describe, expect, it } from 'vitest';
import { hmacSha256Hex, timingSafeEqual, verifyHmacSha256Signature } from '../src/index.ts';

describe('verifyHmacSha256Signature()', () => {
	it('accepts a matching prefixed HMAC signature when the secret and message match', async () => {
		const signature = `sha256=${await hmacSha256Hex('secret', 'hello')}`;

		await expect(verifyHmacSha256Signature({
			secret: 'secret',
			message: 'hello',
			signature,
			prefix: 'sha256=',
		})).resolves.toEqual({ ok: true });
	});

	it('rejects a matching digest when the expected prefix is missing', async () => {
		const signature = await hmacSha256Hex('secret', 'hello');

		await expect(verifyHmacSha256Signature({
			secret: 'secret',
			message: 'hello',
			signature,
			prefix: 'sha256=',
		})).resolves.toEqual({ ok: false, reason: 'invalid_signature' });
	});
});

describe('timingSafeEqual()', () => {
	it('returns false when the strings have different lengths', () => {
		expect(timingSafeEqual('abc', 'abcd')).toBe(false);
	});
});
