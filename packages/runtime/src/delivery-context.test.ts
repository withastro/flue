import { describe, expect, it } from 'vitest';
import { renderWithFrame } from './hooks/frame.ts';
import { useDeliveryContext } from './hooks/use-delivery-context.ts';
import { parseDeliveredInput } from './runtime/schemas.ts';

describe('private delivery context', () => {
	it('is stripped from DeliveredMessage and snapshotted for durable input', () => {
		const context = { tenant: 'acme', nested: { attempt: 1 } };
		const parsed = parseDeliveredInput({
			kind: 'user',
			body: 'hello',
			deliveryContext: context,
			deliveryMode: 'fifo',
		});
		context.nested.attempt = 2;
		expect(parsed.message).toEqual({ kind: 'user', body: 'hello' });
		expect(parsed.deliveryContext).toEqual({ tenant: 'acme', nested: { attempt: 1 } });
		expect(parsed.deliveryMode).toBe('fifo');
		expect(JSON.stringify(parsed.message)).not.toContain('acme');
	});

	it('is readable by closures created during an agent render', () => {
		const rendered = renderWithFrame(
			() => {
				const context = useDeliveryContext<{ tenant: string }>();
				return () => context?.tenant;
			},
			{
				snapshot: new Map(),
				store: undefined,
				delivery: { kind: 'user', body: 'visible' },
				deliveryContext: { tenant: 'private' },
			},
		);
		expect(rendered.result()).toBe('private');
	});
});
