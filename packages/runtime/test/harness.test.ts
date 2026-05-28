import { describe, expect, it } from 'vitest';

import { createSessionAffinityKey, normalizeProviderSessionId } from '../src/harness.ts';

describe('provider session affinity keys', () => {
	it('preserves short keys for readable provider affinity', () => {
		expect(createSessionAffinityKey('local', 'waiter', 'default')).toBe('local::waiter::default');
	});

	it('caps long keys at provider-safe length with a stable hash suffix', () => {
		const key = createSessionAffinityKey(
			'waiter-source-catalog-bounded-test',
			'explorer-tasker',
			'default:explorer:with-extra-long-context',
		);

		expect(key).toHaveLength(64);
		expect(key).toMatch(/:[a-f0-9]{16}$/);
		expect(key).toBe(
			createSessionAffinityKey(
				'waiter-source-catalog-bounded-test',
				'explorer-tasker',
				'default:explorer:with-extra-long-context',
			),
		);
	});

	it('keeps different long keys distinct', () => {
		const first = normalizeProviderSessionId('x'.repeat(100));
		const second = normalizeProviderSessionId(`${'x'.repeat(99)}y`);

		expect(first).toHaveLength(64);
		expect(second).toHaveLength(64);
		expect(first).not.toBe(second);
	});
});
