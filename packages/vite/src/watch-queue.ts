/**
 * Serialized, coalescing queue for watcher-driven work (agent re-scans,
 * Cloudflare input regeneration).
 *
 * Runs never overlap, and a run scheduled while another is already QUEUED
 * (not yet started) is dropped: the queued run reads the latest disk state
 * when it eventually executes, so it observes everything the dropped run
 * would have. A run scheduled while one is IN FLIGHT still queues — the
 * in-flight run may have read disk before the triggering event. A burst of
 * watcher events (branch switch, format-on-save across files) therefore
 * executes at most one in-flight run plus one queued run, instead of one
 * full run per event.
 */
export interface WatchQueue {
	/** Schedule `run` behind in-flight work; coalesces with an already-queued run. */
	schedule(run: () => Promise<void>): Promise<void>;
	/** Resolves once all currently scheduled work has settled. Never rejects. */
	settled(): Promise<void>;
}

export function createWatchQueue(): WatchQueue {
	let queue: Promise<void> = Promise.resolve();
	let queued = false;
	return {
		schedule(run) {
			if (queued) return queue;
			queued = true;
			const wrapped = async () => {
				// Cleared at START of the run: events arriving mid-run must queue
				// a follow-up, because this run may already have read disk.
				queued = false;
				await run();
			};
			queue = queue.then(wrapped, wrapped);
			return queue;
		},
		settled() {
			return queue.then(
				() => undefined,
				() => undefined,
			);
		},
	};
}
