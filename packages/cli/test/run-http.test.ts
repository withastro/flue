import { describe, expect, it } from 'vitest';
import { parseHeaders, resolveServerUrl } from '../src/lib/run-http.ts';

describe('parseHeaders()', () => {
	it('parses values containing colons and lets the later duplicate win', () => {
		expect(parseHeaders(['Authorization: first', 'X-Time: 10:30', 'authorization: second'])).toEqual({
			'X-Time': '10:30',
			authorization: 'second',
		});
	});

	it('rejects malformed headers', () => {
		expect(() => parseHeaders(['missing separator'])).toThrow('Invalid header');
		expect(() => parseHeaders(['bad name: value'])).toThrow('Invalid header name');
	});
});

describe('resolveServerUrl()', () => {
	it('uses the local origin root when server is omitted', () => {
		expect(resolveServerUrl(undefined, 'http://127.0.0.1:4000')).toBe('http://127.0.0.1:4000');
	});

	it('joins a path-only server to the local origin as the authored mount', () => {
		expect(resolveServerUrl('/other', 'http://127.0.0.1:4000')).toBe(
			'http://127.0.0.1:4000/other',
		);
	});

	it('uses an absolute server URL as the complete attachment URL', () => {
		expect(resolveServerUrl('https://example.com/flue', 'http://127.0.0.1:4000')).toBe(
			'https://example.com/flue',
		);
	});
});
