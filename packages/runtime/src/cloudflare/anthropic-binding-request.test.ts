import { describe, expect, it } from 'vitest';
import { prepareAnthropicBindingRequest } from './anthropic-binding-request.ts';

const headers = { 'x-session-affinity': 's1', 'Anthropic-Beta': 'configured' };

describe('prepareAnthropicBindingRequest', () => {
	it('stable messages namespace preserves body and headers verbatim', () => {
		const params = { model: 'm', stream: true, betas: ['a'] };
		const { body, extraHeaders } = prepareAnthropicBindingRequest('messages', params, headers);
		expect(body).toEqual(params);
		expect(extraHeaders).toEqual(headers);
	});

	it('beta namespace strips betas and joins them into the anthropic-beta header', () => {
		const { body, extraHeaders } = prepareAnthropicBindingRequest(
			'beta',
			{ model: 'm', stream: true, betas: ['a', 'b'] },
			headers,
		);
		expect(body).toEqual({ model: 'm', stream: true });
		expect(extraHeaders).toEqual({ 'x-session-affinity': 's1', 'anthropic-beta': 'a,b' });
	});

	it('beta namespace sends an explicit empty header for betas: []', () => {
		const { body, extraHeaders } = prepareAnthropicBindingRequest(
			'beta',
			{ model: 'm', betas: [] },
			headers,
		);
		expect(body).toEqual({ model: 'm' });
		expect(extraHeaders).toEqual({ 'x-session-affinity': 's1', 'anthropic-beta': '' });
	});

	it.each([
		['undefined', undefined],
		['null', null],
	])('beta namespace keeps configured headers when betas is %s', (_name, betas) => {
		const { body, extraHeaders } = prepareAnthropicBindingRequest(
			'beta',
			{ model: 'm', betas },
			headers,
		);
		expect(body).toEqual({ model: 'm' });
		expect(extraHeaders).toEqual(headers);
	});

	it('does not mutate the inputs', () => {
		const params = { model: 'm', betas: ['a'] };
		const input = { ...headers };
		prepareAnthropicBindingRequest('beta', params, input);
		expect(params).toEqual({ model: 'm', betas: ['a'] });
		expect(input).toEqual(headers);
	});
});
