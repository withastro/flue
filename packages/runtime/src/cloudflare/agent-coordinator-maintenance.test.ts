import { describe, expect, it } from 'vitest';
import { isInternalMaintenanceRequest } from './agent-coordinator.ts';

describe('Cloudflare internal maintenance routing', () => {
	it('requires the runtime-only origin, exact method, and exact path', () => {
		expect(
			isInternalMaintenanceRequest(
				new Request('https://flue.invalid/__flue/internal/purge', { method: 'POST' }),
				'POST',
				'/__flue/internal/purge',
			),
		).toBe(true);
		for (const request of [
			new Request('https://customer.example/__flue/internal/purge', { method: 'POST' }),
			new Request('https://flue.invalid/__flue/internal/purge', { method: 'GET' }),
			new Request('https://flue.invalid/__flue/internal/purge/extra', { method: 'POST' }),
		]) {
			expect(
				isInternalMaintenanceRequest(request, 'POST', '/__flue/internal/purge'),
			).toBe(false);
		}
	});
});
