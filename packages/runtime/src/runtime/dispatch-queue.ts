import type { DeliveredMessage, DispatchReceipt } from '../types.ts';

export interface DispatchInput {
	submissionId: string;
	agent: string;
	id: string;
	message: DeliveredMessage;
	/** Instance-creation data; the seed, consulted only when this send creates. */
	initialData?: unknown;
	/**
	 * Send condition, consumed at admission and never stored durably: a
	 * string continues only the incarnation with that uid (else 404); `null`
	 * creates only when no instance exists (else 409). Omit to send
	 * unconditionally.
	 */
	uid?: string | null;
	acceptedAt: string;
}

export interface DispatchQueue {
	enqueue(input: DispatchInput): Promise<DispatchReceipt>;
}
