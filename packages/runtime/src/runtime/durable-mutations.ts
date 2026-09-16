const encoder = new TextEncoder();

/** A bounded, payload-free observation of one durable write attempt. */
export interface DurableMutationObservation {
	readonly operation: 'admit' | 'abort' | 'purge';
	readonly scope: 'submission' | 'instance';
	/** SHA-256 of the length-delimited scoped identity. Raw ids are never exposed. */
	readonly identityHash: string;
	readonly affected: number;
	readonly noOp: boolean;
}

export type DurableMutationObserver = (
	observation: Readonly<DurableMutationObservation>,
) => void | Promise<void>;

const observers = new Set<DurableMutationObserver>();

/**
 * Observe durable mutation outcomes without receiving the normal agent event
 * context. The observation contains no payload, result, error, prompt, or raw
 * identity. Delivery is live-only and best-effort; durable stores remain truth.
 */
export function observeDurableMutations(observer: DurableMutationObserver): () => void {
	observers.add(observer);
	return () => observers.delete(observer);
}

/** Hash a scoped durable identity before it reaches the public observation stream. */
export async function hashDurableIdentity(parts: readonly string[]): Promise<string> {
	const bytes = encoder.encode(parts.map((part) => `${part.length}:${part}`).join('|'));
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Internal: publish only after the store has returned its exact outcome. */
export function publishDurableMutation(observation: DurableMutationObservation): void {
	const frozen = Object.freeze({ ...observation });
	for (const observer of [...observers]) {
		try {
			void Promise.resolve(observer(frozen)).catch(reportObserverFailure);
		} catch (error) {
			reportObserverFailure(error);
		}
	}
}

function reportObserverFailure(error: unknown): void {
	console.error('[flue:durable-mutation-observer] subscriber failed:', error);
}
