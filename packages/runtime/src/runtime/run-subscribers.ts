/** Per-run, in-process subscriber registry for live SSE tailing. */

import type { FlueEvent } from '../types.ts';

export type RunSubscriberListener = (event: FlueEvent) => void;

export interface RunSubscriberRegistry {
	subscribe(runId: string, listener: RunSubscriberListener): () => void;
	publish(runId: string, event: FlueEvent): void;
	/** Release registry state for a terminal run. */
	complete(runId: string): void;
}

export function createRunSubscriberRegistry(): RunSubscriberRegistry {
	const listeners = new Map<string, Set<RunSubscriberListener>>();

	return {
		subscribe(runId, listener) {
			let bucket = listeners.get(runId);
			if (!bucket) {
				bucket = new Set();
				listeners.set(runId, bucket);
			}
			bucket.add(listener);
			return () => {
				const current = listeners.get(runId);
				if (!current) return;
				current.delete(listener);
				if (current.size === 0) listeners.delete(runId);
			};
		},
		publish(runId, event) {
			const bucket = listeners.get(runId);
			if (!bucket || bucket.size === 0) return;
			// Snapshot to a local array so listeners that unsubscribe
			// themselves during dispatch don't perturb the iteration.
			for (const listener of [...bucket]) {
				try {
					listener(event);
				} catch (error) {
					console.error('[flue:run-subscribers] listener threw:', error);
				}
			}
		},
		complete(runId) {
			listeners.delete(runId);
		},
	};
}
