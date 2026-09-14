/**
 * Shared retry/liveness policy for the SDK's conversation-stream followers.
 *
 * `observe()` (observe.ts) and the settlement followers `wait()`/`read()`
 * (settle.ts) run different loops over the same `updates` stream — a phased
 * state machine that recovers by re-hydrating a fresh `history()` snapshot
 * versus a linear settlement scan that recovers by recreating the stream
 * from the admission offset — but they share one failure policy: what counts
 * as stale, which auth failures are transient, how fast retries back off,
 * and how redelivered chunks are recognized. Keeping the policy here keeps
 * the two loops in agreement without forcing either into the other's shape.
 */

import type { ConversationChunkPosition } from './conversation-stream.ts';

/**
 * How many *consecutive* 401/403 failures a stream follower retries before it
 * fails. Auth failures are usually transient here: headers re-resolve per
 * request (async header factories mint fresh tokens), so a 401 from a
 * token-expiry race heals on the very next attempt — the first retry fires
 * after ~1s of backoff. A genuinely revoked credential still surfaces within
 * this many attempts (single-digit seconds): `observe()` publishes phase
 * `'error'`; `wait()`/`read()` reject with the last auth error.
 *
 * The streak resets only on real progress — a successful `history()` read or
 * a delivered chunk — never on merely issuing a request, opening a stream, or
 * receiving an empty batch, so a flapping credential cannot retry forever.
 * Each follow episode (an `observe()` subscribe or `refresh()`, one
 * `wait()`/`read()` call) starts with a fresh budget.
 */
export const AUTH_FAILURE_LIMIT = 3;

/**
 * How long an active stream may stay completely silent — no chunk and no
 * transport activity tick — before it is declared stale and torn down. The
 * runtime produces activity at least every ~30s on both live modes (an empty
 * long-poll response at the poll window, an idle SSE control event), so this
 * is 3× that cadence: three consecutive missed windows means the connection
 * is dead in a way nothing below the SDK will ever report — a half-open TCP
 * connection, a proxy blackhole, or the stream client's internal retry loop,
 * which retries 5xx forever without surfacing. Recovery is each follower's
 * standard transient path: cancel the stream (aborting the underlying
 * connection), then re-hydrate through backoff (`observe()`) or recreate the
 * stream from the admission offset (`wait()`/`read()`). A stall is not an
 * auth failure, so it never consumes the bounded auth-retry budget.
 */
export const STALE_STREAM_TIMEOUT_MS = 90_000;

export const HEALTHY_STREAM_MS = 30_000;

/**
 * Exponential retry backoff: 1s doubled per consecutive attempt, capped at
 * 30s. `attempt` is zero-based (attempt 0 → 1s).
 */
export function retryBackoffMs(attempt: number): number {
	return Math.min(1000 * 2 ** attempt, 30_000);
}

/** HTTP status carried by an SDK or transport error, when there is one. */
export function statusOf(error: unknown): number | undefined {
	return error && typeof error === 'object' && 'status' in error && typeof error.status === 'number'
		? error.status
		: undefined;
}

/** Lexicographic order on chunk positions: by `batch`, then `index`. */
export function comparePosition(
	a: ConversationChunkPosition,
	b: ConversationChunkPosition,
): number {
	return a.batch !== b.batch ? a.batch - b.batch : a.index - b.index;
}
