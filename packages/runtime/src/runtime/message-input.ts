/**
 * The one input-sugar rule for delivery: a bare string is shorthand for a
 * user message. Shared by every `dispatch` surface — the top-level verb, the
 * `init()` handle, and `useDispatchMessage()` — so the shorthand cannot drift
 * between them. Everything else about the message (kind vocabulary, signal
 * shape, attachment limits) is validated by the admission path itself.
 */

import type { DeliveredMessage, DeliveredMessageInput } from '../types.ts';

/** Expand the string shorthand to a `kind: 'user'` message; pass objects through. */
export function normalizeMessageInput(message: DeliveredMessageInput): DeliveredMessage;
export function normalizeMessageInput(
	message: DeliveredMessageInput | undefined,
): DeliveredMessage | undefined;
export function normalizeMessageInput(
	message: DeliveredMessageInput | undefined,
): DeliveredMessage | undefined {
	return typeof message === 'string' ? { kind: 'user', body: message } : message;
}
