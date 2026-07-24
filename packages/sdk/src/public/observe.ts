import type { BackoffOptions } from '@durable-streams/client';
import type { FlueConversationSnapshot, FlueConversationState } from './conversation.ts';
import {
	applyConversationChunk,
	type ConversationChunkPosition,
	type ConversationStreamChunk,
	createConversationStreamState,
} from './conversation-stream.ts';
import type { FlueEventStream } from './stream.ts';

/**
 * Live mode for conversation observation: `'long-poll'` (offset-resumed polling)
 * or `'sse'` (a long-lived stream for lower-latency token-by-token updates). For
 * a single point-in-time read with no live updates, use `history()` instead.
 *
 * Both modes are safe under at-least-once redelivery. The `message-delta`
 * protocol is append-style with no per-delta sequence, but every chunk carries a
 * monotonic `position`, and `observe()` drops chunks at or below the last applied
 * position. This makes SSE safe despite the durable-stream client re-delivering a
 * batch when a connection drops between its `data` and `control` frames (it
 * reconnects from the pre-batch offset and replays).
 */
export type ConversationLiveMode = 'long-poll' | 'sse';

export type AgentConversationObservationPhase =
	'loading' | 'connecting' | 'live' | 'absent' | 'error' | 'closed';

export interface AgentConversationObservationSnapshot {
	conversation: FlueConversationState | undefined;
	offset: string | undefined;
	phase: AgentConversationObservationPhase;
	error: Error | undefined;
}

export interface AgentConversationObserveOptions {
	live?: ConversationLiveMode;
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
}

export interface AgentConversationObservation {
	getSnapshot(): AgentConversationObservationSnapshot;
	subscribe(listener: () => void): () => void;
	refresh(): void;
	close(reason?: unknown): void;
}

/**
 * Internal composition seam between SDK transport and the observation state
 * machine. Not exported from the package: the client's `observe()` is the only
 * supported way to construct an observation. Tests drive observation through a
 * fake {@link AgentConversationObservationSource}.
 */
export interface AgentConversationObservationSource {
	history(options: { signal?: AbortSignal }): Promise<FlueConversationSnapshot>;
	updates(options: {
		offset: string;
		live?: ConversationLiveMode;
		signal?: AbortSignal;
		backoffOptions?: BackoffOptions;
	}): FlueEventStream<ConversationStreamChunk>;
}

export function createAgentConversationObservation(
	source: AgentConversationObservationSource,
	options: AgentConversationObserveOptions = {},
): AgentConversationObservation {
	const listeners = new Set<() => void>();
	let streamState: FlueConversationState | undefined;
	let snapshot: AgentConversationObservationSnapshot = {
		conversation: undefined,
		offset: undefined,
		phase: 'loading',
		error: undefined,
	};
	let started = false;
	let closed = false;
	let generation = 0;
	let controller: AbortController | undefined;
	let removeExternalAbortListener: (() => void) | undefined;
	let stream: FlueEventStream<ConversationStreamChunk> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;
	// Highest chunk position applied to `streamState`. Chunks at or below it are
	// redeliveries (e.g. an SSE reconnect replaying a batch) and are skipped so
	// append-style deltas are never double-applied. Reset on every (re)hydrate:
	// conversation reads are exclusive, so live chunks are always strictly after
	// the freshly materialized snapshot, leaving nothing to dedupe against it.
	let lastApplied: ConversationChunkPosition | undefined;

	const publish = (next: AgentConversationObservationSnapshot) => {
		snapshot = next;
		for (const listener of listeners) listener();
	};

	const isCurrent = (value: number) => !closed && value === generation;

	const clearActive = () => {
		removeExternalAbortListener?.();
		removeExternalAbortListener = undefined;
		controller?.abort();
		controller = undefined;
		stream?.cancel();
		stream = undefined;
		if (retryTimer) clearTimeout(retryTimer);
		retryTimer = undefined;
	};

	// On reconnect we rehydrate a fresh snapshot via `history()` rather than
	// resuming the incremental stream — cheap because it is server-materialized,
	// and it re-bases `lastApplied`. Exactly-once application within a live
	// connection is enforced separately by the per-chunk `position` dedup in
	// `follow()`, which also absorbs the durable-stream client's mid-batch SSE
	// redelivery.
	const scheduleRetry = (value: number, error: Error) => {
		if (!isCurrent(value)) return;
		if (controller?.signal.aborted) {
			publish({ ...snapshot, phase: 'closed', error: undefined });
			return;
		}
		if (isFatalStatus(error)) {
			publish({ ...snapshot, phase: 'error', error });
			return;
		}
		publish({ ...snapshot, phase: 'connecting', error });
		const delay = Math.min(1000 * 2 ** reconnectAttempt++, 30_000);
		retryTimer = setTimeout(() => {
			retryTimer = undefined;
			if (!isCurrent(value)) return;
			void hydrate(value);
		}, delay);
	};

	const follow = async (value: number, offset: string) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: 'live', error: undefined });
		let nextStream: FlueEventStream<ConversationStreamChunk>;
		try {
			nextStream = source.updates({
				offset,
				live: options.live,
				signal: controller?.signal,
				backoffOptions: options.backoffOptions,
			});
		} catch (error) {
			scheduleRetry(value, toError(error));
			return;
		}
		stream = nextStream;
		try {
			for await (const chunk of nextStream) {
				if (!isCurrent(value) || stream !== nextStream) return;
				if (!streamState) throw new Error('Agent conversation updates require materialized state.');
				// Drop redelivered chunks (at-least-once transports replay the
				// in-flight batch on reconnect). Positions are monotonic but not
				// contiguous — zero-chunk batches leave gaps — so this only
				// compares, never asserts contiguity.
				if (lastApplied !== undefined && comparePosition(chunk.position, lastApplied) <= 0) {
					continue;
				}
				streamState = applyConversationChunk(streamState, chunk);
				lastApplied = chunk.position;
				publish({
					conversation: streamState,
					offset: nextStream.offset,
					phase: 'live',
					error: undefined,
				});
				reconnectAttempt = 0;
			}
			if (!isCurrent(value) || stream !== nextStream) return;
			stream = undefined;
			scheduleRetry(value, new Error('Agent conversation stream ended unexpectedly.'));
		} catch (error) {
			if (!isCurrent(value) || stream !== nextStream) return;
			stream = undefined;
			scheduleRetry(value, toError(error));
		}
	};

	const hydrate = async (value: number) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: streamState ? 'connecting' : 'loading', error: undefined });
		try {
			const history = await source.history({ signal: controller?.signal });
			if (!isCurrent(value)) return;
			streamState = createConversationStreamState(history);
			lastApplied = undefined;
			// Do not reset reconnectAttempt here: a successful history read is not
			// progress on the updates stream. Resetting it on every hydrate defeats
			// backoff growth when the stream keeps failing right after (fixed ~1s
			// hydrate/fail loop). The real reset lives in follow()'s chunk loop,
			// once a chunk actually arrives.
			publish({
				conversation: streamState,
				offset: history.offset,
				phase: 'connecting',
				error: undefined,
			});
			await follow(value, history.offset);
		} catch (error) {
			if (!isCurrent(value)) return;
			const normalized = toError(error);
			if (statusOf(error) === 404) {
				streamState = undefined;
				reconnectAttempt = 0;
				publish({ conversation: undefined, offset: undefined, phase: 'absent', error: undefined });
				return;
			}
			scheduleRetry(value, normalized);
		}
	};

	const begin = () => {
		generation++;
		controller = new AbortController();
		removeExternalAbortListener = linkSignal(options.signal, controller, () => {
			if (!closed) {
				closed = true;
				generation++;
				clearActive();
				publish({ ...snapshot, phase: 'closed', error: undefined });
			}
		});
		reconnectAttempt = 0;
		const value = generation;
		queueMicrotask(() => void hydrate(value));
	};

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			if (!started && !closed) {
				started = true;
				begin();
			}
			return () => listeners.delete(listener);
		},
		refresh() {
			if (closed) return;
			clearActive();
			started = true;
			begin();
		},
		close(reason) {
			if (closed) return;
			closed = true;
			generation++;
			clearActive();
			publish({
				...snapshot,
				phase: 'closed',
				error: reason === undefined ? undefined : toError(reason),
			});
			listeners.clear();
		},
	};
}

function linkSignal(
	signal: AbortSignal | undefined,
	controller: AbortController,
	onAbort: () => void,
): (() => void) | undefined {
	if (!signal) return undefined;
	if (signal.aborted) {
		controller.abort(signal.reason);
		onAbort();
	} else {
		const handler = () => {
			controller.abort(signal.reason);
			onAbort();
		};
		signal.addEventListener('abort', handler, { once: true });
		return () => signal.removeEventListener('abort', handler);
	}
	return undefined;
}

function statusOf(error: unknown): number | undefined {
	return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
		? error.status
		: undefined;
}

function isFatalStatus(error: unknown): boolean {
	const status = statusOf(error);
	return status === 400 || status === 401 || status === 403;
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/** Lexicographic order on chunk positions: by `batch`, then `index`. */
function comparePosition(a: ConversationChunkPosition, b: ConversationChunkPosition): number {
	return a.batch !== b.batch ? a.batch - b.batch : a.index - b.index;
}
