import type { JsonValue } from '../json-snapshot.ts';
import { requireRenderFrame } from './frame.ts';

/**
 * Read the private context attached to the current delivery.
 *
 * Unlike {@link useDelivery}, this value is never written to conversation
 * records or sent to a model provider. It is a durable, JSON-only value for
 * agent code and tool closures. The cursor advances with joined deliveries
 * and is restored from the durable submission row after a restart.
 */
export function useDeliveryContext<T extends JsonValue = JsonValue>(): T | undefined {
	return requireRenderFrame('useDeliveryContext').state?.deliveryContext as T | undefined;
}
