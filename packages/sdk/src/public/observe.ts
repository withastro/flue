import type { BackoffOptions } from '@durable-streams/client';
import type { FlueConversationSnapshot, FlueConversationState } from './conversation.ts';
import {
	applyConversationChunk,
	type ConversationChunkPosition,
	type ConversationStreamChunk,
	createConversationStreamState,
} from './conversation-stream.ts';
import {
	AUTH_FAILURE_LIMIT,
	comparePosition,
	HEALTHY_STREAM_MS,
	retryBackoffMs,
	STALE_STREAM_TIMEOUT_MS,
	statusOf,
} from './follow-policy.ts';
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
	/**
	 * Hydrate only the newest `limit` messages (a positive integer) instead of
	 * the whole conversation. The observed window then grows forward with live
	 * updates and never shrinks: re-hydration after a reconnect reads from the
	 * window's oldest message through the head, so no gap opens below it, and
	 * `conversation-reset` snapshots stay cut to the window. The window may
	 * hold more than `limit` messages: it always includes every message that
	 * can still receive live content (a response still streaming above later
	 * messages). The state's `before` cursor reads older messages with
	 * `historyBefore()`; it stays the same for the life of the window, and a
	 * changed cursor means the window re-based (discard older pages loaded
	 * with the previous one). Settlements always cover the whole
	 * conversation. Omit to observe the whole conversation.
	 */
	limit?: number;
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
	/**
	 * `limit` reads the newest N messages; `from` reads from a cursor's message
	 * (inclusive) through the head. At most one is set; neither reads the
	 * whole conversation.
	 */
	history(options: {
		signal?: AbortSignal;
		limit?: number;
		from?: string;
	}): Promise<FlueConversationSnapshot>;
	updates(options: {
		offset: string;
		live?: ConversationLiveMode;
		signal?: AbortSignal;
		backoffOptions?: BackoffOptions;
		/**
		 * A bounded observation's window: the runtime cuts
		 * `conversation-reset` snapshots to it (anchored at `from`, falling
		 * back to the newest `limit` messages).
		 */
		window?: { from?: string; limit?: number };
		/**
		 * Liveness seam: invoked on every transport batch, including empty
		 * keep-alive batches that yield no chunks. Feeds the stale-stream
		 * watchdog in `follow()`.
		 */
		onActivity?: () => void;
	}): FlueEventStream<ConversationStreamChunk>;
}

export function createAgentConversationObservation(
	source: AgentConversationObservationSource,
	options: AgentConversationObserveOptions = {},
): AgentConversationObservation {
	const limit = options.limit;
	if (limit !== undefined) assertHistoryLimit(limit, 'observe()');
	const listeners = new Set<() => void>();
	// Where a bounded observation's window starts. `newest` asks for the newest
	// `limit` messages (a fresh episode, or a re-base); `start` means the window
	// already reaches the conversation's first message, so re-hydration reads
	// the whole conversation; `from` pins the window to its oldest message so
	// re-hydration after a reconnect never leaves a gap below what the client
	// holds. The cursor is the runtime's opaque token (bound to one stream
	// generation); `oldestId` is the id of the window's oldest message, kept
	// separately so resets from a runtime that cannot window them are cut
	// locally without interpreting the cursor. Unused when `limit` is undefined.
	let historyWindow: WindowAnchor = { kind: 'newest' };
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
	// Stale-stream watchdog for the active stream. Armed by follow(), reset on
	// every chunk and transport activity tick (plain setTimeout reset, no
	// interval), cleared whenever the active stream is torn down.
	let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;
	// Consecutive 401/403 failures since the last real progress. See
	// {@link AUTH_FAILURE_LIMIT} for the reset rules.
	let authFailureStreak = 0;
	// Highest chunk position applied to `streamState`. Chunks at or below it are
	// redeliveries (e.g. an SSE reconnect replaying a batch) and are skipped so
	// append-style deltas are never double-applied. Reset on every (re)hydrate:
	// conversation reads are exclusive, so live chunks are always strictly after
	// the freshly materialized snapshot, leaving nothing to dedupe against it.
	let lastApplied: ConversationChunkPosition | undefined;
	// Stream generation the current state was hydrated from. A live
	// `stream-checkpoint` chunk carrying a different incarnation means the
	// stream was reset and regrown under us — held offsets and `lastApplied`
	// belong to a dead generation (whose replayed positions dedup would
	// silently eat) — so follow() resyncs with an immediate re-hydrate.
	let observedIncarnation: string | undefined;

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
		disarmWatchdog();
	};

	const disarmWatchdog = () => {
		if (watchdogTimer) clearTimeout(watchdogTimer);
		watchdogTimer = undefined;
	};

	// On reconnect we rehydrate a fresh snapshot via `history()` rather than
	// resuming the incremental stream — cheap because it is server-materialized,
	// and it re-bases `lastApplied`. Exactly-once application within a live
	// connection is enforced separately by the per-chunk `position` dedup in
	// `follow()`, which also absorbs the durable-stream client's mid-batch SSE
	// redelivery.
	const scheduleRetry = (value: number, error: Error) => {
		if (!isCurrent(value)) return;
		// Entering retry means no stream is active (every caller tears its
		// stream down first), so nothing is left for the watchdog to guard
		// until follow() arms it again.
		disarmWatchdog();
		if (controller?.signal.aborted) {
			publish({ ...snapshot, phase: 'closed', error: undefined });
			return;
		}
		const status = statusOf(error);
		// 400 is protocol misuse — no retry can help. 401/403 retry with fresh
		// per-request headers until AUTH_FAILURE_LIMIT consecutive failures.
		if (status === 401 || status === 403) authFailureStreak++;
		if (status === 400 || authFailureStreak >= AUTH_FAILURE_LIMIT) {
			publish({ ...snapshot, phase: 'error', error });
			return;
		}
		publish({ ...snapshot, phase: 'connecting', error });
		const delay = retryBackoffMs(reconnectAttempt++);
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
		// Declare the stream stale after STALE_STREAM_TIMEOUT_MS of total
		// silence: cancel it (aborting the underlying connection) and route
		// through scheduleRetry as a transient error — a stall carries no
		// status, so it keeps backoff semantics and never touches the
		// auth-failure streak.
		let firstActivityAt: number | undefined;
		const settleAttempt = () => {
			if (firstActivityAt !== undefined && Date.now() - firstActivityAt >= HEALTHY_STREAM_MS) {
				reconnectAttempt = 0;
			}
		};
		const onStale = () => {
			watchdogTimer = undefined;
			if (!isCurrent(value) || stream !== nextStream) return;
			stream = undefined;
			nextStream.cancel();
			settleAttempt();
			scheduleRetry(
				value,
				new Error(
					`Agent conversation stream stalled: no activity for ${STALE_STREAM_TIMEOUT_MS}ms.`,
				),
			);
		};
		const armWatchdog = () => {
			firstActivityAt ??= Date.now();
			if (watchdogTimer) clearTimeout(watchdogTimer);
			watchdogTimer = setTimeout(onStale, STALE_STREAM_TIMEOUT_MS);
		};
		try {
			nextStream = source.updates({
				offset,
				live: options.live,
				signal: controller?.signal,
				backoffOptions: options.backoffOptions,
				...(limit !== undefined && historyWindow.kind === 'from'
					? { window: { from: historyWindow.cursor, limit } }
					: {}),
				onActivity: armWatchdog,
			});
		} catch (error) {
			scheduleRetry(value, toError(error));
			return;
		}
		stream = nextStream;
		armWatchdog();
		try {
			for await (const chunk of nextStream) {
				if (!isCurrent(value) || stream !== nextStream) return;
				// Any delivered chunk is liveness, even one dedup discards below.
				armWatchdog();
				// Continuity markers are transport metadata, not content: no
				// position (never enters dedup), nothing to apply, not progress.
				// A changed incarnation means the stream was reset and regrown —
				// cancel and re-hydrate immediately. This is routine recovery,
				// not a failure: phase dips to 'connecting' with no error and no
				// backoff, and the bounded auth budget is untouched.
				if (chunk.type === 'stream-checkpoint') {
					if (observedIncarnation === undefined || chunk.incarnation === observedIncarnation) {
						continue;
					}
					stream = undefined;
					nextStream.cancel();
					disarmWatchdog();
					// A regrown stream holds different messages: the window's
					// anchor belongs to the dead generation.
					historyWindow = { kind: 'newest' };
					void hydrate(value);
					return;
				}
				if (!streamState) throw new Error('Agent conversation updates require materialized state.');
				// Drop redelivered chunks (at-least-once transports replay the
				// in-flight batch on reconnect). Positions are monotonic but not
				// contiguous — zero-chunk batches leave gaps — so this only
				// compares, never asserts contiguity.
				if (lastApplied !== undefined && comparePosition(chunk.position, lastApplied) <= 0) {
					continue;
				}
				let nextState = applyConversationChunk(streamState, chunk);
				// Keep a bounded observation's window across a reset. When the
				// window cannot be kept, re-base: cancel and re-hydrate the newest
				// window (routine recovery, like an incarnation change).
				if (chunk.type === 'conversation-reset' && limit !== undefined) {
					const windowed = rewindow(nextState, chunk.snapshot);
					if (!windowed) {
						stream = undefined;
						nextStream.cancel();
						disarmWatchdog();
						historyWindow = { kind: 'newest' };
						void hydrate(value);
						return;
					}
					nextState = windowed;
				}
				streamState = nextState;
				lastApplied = chunk.position;
				publish({
					conversation: streamState,
					offset: nextStream.offset,
					phase: 'live',
					error: undefined,
				});
				// An applied chunk is real progress: reset backoff growth and
				// refill the transient-auth budget. Opening the stream or
				// receiving an empty batch is NOT progress and resets nothing.
				reconnectAttempt = 0;
				authFailureStreak = 0;
			}
			if (!isCurrent(value) || stream !== nextStream) return;
			stream = undefined;
			settleAttempt();
			scheduleRetry(value, new Error('Agent conversation stream ended unexpectedly.'));
		} catch (error) {
			if (!isCurrent(value) || stream !== nextStream) return;
			stream = undefined;
			settleAttempt();
			scheduleRetry(value, toError(error));
		}
	};

	const hydrate = async (value: number) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: streamState ? 'connecting' : 'loading', error: undefined });
		try {
			const history = await source.history({
				signal: controller?.signal,
				...historyWindowRequest(),
			});
			if (!isCurrent(value)) return;
			// A successful read is real progress: the credential demonstrably
			// works, so the transient-auth budget refills. Issuing the request
			// alone must not refill it, or a flapping credential (401 → issue →
			// 401 → …) would retry forever.
			authFailureStreak = 0;
			// Defense in depth: an anchored read answered by a different stream
			// generation belongs to different content, even if its cursor
			// resolved. Re-base rather than mix generations.
			if (
				limit !== undefined &&
				historyWindow.kind === 'from' &&
				observedIncarnation !== undefined &&
				history.incarnation !== undefined &&
				history.incarnation !== observedIncarnation
			) {
				historyWindow = { kind: 'newest' };
				void hydrate(value);
				return;
			}
			streamState = createConversationStreamState(history);
			if (limit !== undefined) {
				// `before` names the oldest returned message when older ones
				// exist. A runtime predating bounded history omits it and returns
				// the whole conversation — equivalent to `start`.
				const oldest = history.messages[0];
				historyWindow =
					typeof history.before === 'string' && oldest
						? { kind: 'from', cursor: history.before, oldestId: oldest.id }
						: { kind: 'start' };
				streamState = { ...streamState, before: windowBefore(historyWindow) };
			}
			lastApplied = undefined;
			// Runtimes always stamp the incarnation; `undefined` (a snapshot from
			// a server predating it) disables checkpoint comparison entirely.
			observedIncarnation = history.incarnation;
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
			// The window's anchor message is gone (the stream was reset and
			// regrown under us): re-base on the newest window immediately.
			// Routine recovery, like an incarnation change — no backoff, and a
			// `newest` read carries no cursor, so this cannot loop.
			if (limit !== undefined && historyWindow.kind === 'from' && statusOf(error) === 410) {
				historyWindow = { kind: 'newest' };
				void hydrate(value);
				return;
			}
			if (statusOf(error) === 404) {
				historyWindow = { kind: 'newest' };
				streamState = undefined;
				reconnectAttempt = 0;
				publish({ conversation: undefined, offset: undefined, phase: 'absent', error: undefined });
				return;
			}
			scheduleRetry(value, toError(error));
		}
	};

	const historyWindowRequest = (): { limit?: number; from?: string } => {
		if (limit === undefined) return {};
		if (historyWindow.kind === 'newest') return { limit };
		if (historyWindow.kind === 'from') return { from: historyWindow.cursor };
		return {};
	};

	// Keep the window across a state replaced by a `conversation-reset`
	// snapshot, or return undefined to re-base. A runtime that supports
	// bounded history cuts the reset to the window itself (the snapshot then
	// carries `before`): accept it iff it is still our window. An older
	// runtime sends the whole transcript: cut it locally at the oldest held
	// message — resets re-project the same append-only transcript, so it
	// normally survives. Anything else re-bases.
	const rewindow = (
		state: FlueConversationState,
		reset: FlueConversationSnapshot,
	): FlueConversationState | undefined => {
		const expected = windowBefore(historyWindow);
		if (reset.before !== undefined) {
			return historyWindow.kind !== 'newest' && reset.before === expected ? state : undefined;
		}
		if (historyWindow.kind === 'start') return { ...state, before: null };
		if (historyWindow.kind !== 'from') return undefined;
		const anchor = historyWindow.oldestId;
		const index = state.messages.findIndex((message) => message.id === anchor);
		if (index < 0) return undefined;
		return { ...state, messages: state.messages.slice(index), before: expected };
	};

	const begin = () => {
		generation++;
		historyWindow = { kind: 'newest' };
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
		// Every observation episode gets a fresh auth budget: a manual
		// refresh() after an auth-fatal error retries with fresh headers.
		authFailureStreak = 0;
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

type WindowAnchor =
	{ kind: 'newest' } | { kind: 'start' } | { kind: 'from'; cursor: string; oldestId: string };

function windowBefore(window: WindowAnchor): string | null {
	return window.kind === 'from' ? window.cursor : null;
}

/** Validates a bounded-read `limit`: a positive safe integer. */
export function assertHistoryLimit(limit: number, method: string): void {
	if (!Number.isSafeInteger(limit) || limit < 1) {
		throw new Error(
			`The client ${method} limit must be a positive integer (got ${String(limit)}).`,
		);
	}
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

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
