import { describe, expect, it } from 'vitest';
import {
	registerProvider,
	resolveRegisteredModel,
} from '../src/runtime/providers.ts';

describe('registered providers', () => {
	it('defaults HTTP provider input to text', () => {
		registerProvider('test-text-provider', {
			api: 'openai-completions',
			baseUrl: 'https://example.com/v1',
		});

		expect(resolveRegisteredModel('test-text-provider', 'model')?.input).toEqual([
			'text',
		]);
	});

	it('uses declared HTTP provider input modalities', () => {
		registerProvider('test-vision-provider', {
			api: 'openai-completions',
			baseUrl: 'https://example.com/v1',
			input: ['text', 'image'],
		});

		expect(resolveRegisteredModel('test-vision-provider', 'model')?.input).toEqual([
			'text',
			'image',
		]);
	});
});
