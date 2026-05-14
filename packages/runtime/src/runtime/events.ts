/**
 * Global, isolate-scoped subscription to the Flue event stream.
 *
 * `observe()` is the public hook for wiring cross-cutting concerns —
 * error reporting, log forwarding, ad-hoc metrics — into every Flue
 * run handled by the current isolate. Call it at module scope from
 * your `app.ts`; the subscriber receives every event from every run
 * for the lifetime of the isolate.
 *
 * Isolate scoping (Cloudflare): each agent runs in its own Durable
 * Object, which is its own V8 isolate. Your `app.ts` is evaluated
 * once per isolate (the outer Worker + each DO), so each isolate
 * registers its own subscriber list. There is no shared "global"
 * across DOs because there is no shared module state across isolates
 * on the runtime. Practically, this means every isolate independently
 * captures its own events — which is exactly what cross-cutting
 * concerns want.
 *
 * Errors thrown by a subscriber are logged and swallowed; one buggy
 * subscriber does not halt event dispatch to the others or affect the
 * run itself.
 */

import type { FlueContext, FlueEvent } from '../types.ts';

/**
 * Subscriber signature. Receives a fully decorated event (with
 * `runId`, `eventIndex`, `timestamp`, and tree-correlation fields
 * attached) and the originating `FlueContext`.
 */
export type FlueEventSubscriber = (event: FlueEvent, ctx: FlueContext) => void;

const subscribers = new Set<FlueEventSubscriber>();

/**
 * Subscribe to every Flue event emitted in this isolate.
 *
 * Usage (typically at the top of `app.ts`):
 *
 *     import { observe } from '@flue/runtime/app';
 *
 *     observe((event, ctx) => {
 *       if (event.type === 'run_end' && event.isError) {
 *         // ship to your error reporter, metrics sink, etc.
 *       }
 *     });
 *
 * The returned function unsubscribes the listener. Most error
 * reporting and telemetry use cases register once at startup and
 * never unsubscribe — the returned function is provided for tests
 * and dynamic-wiring scenarios.
 *
 * Subscribers are invoked synchronously from the event emit path.
 * They should be cheap and side-effect-only; do not block, do not
 * throw, do not mutate the event. Async work should be queued
 * (e.g. `void fetch(...)`) rather than awaited.
 */
export function observe(subscriber: FlueEventSubscriber): () => void {
	subscribers.add(subscriber);
	return () => {
		subscribers.delete(subscriber);
	};
}

/**
 * Internal: dispatch a single event to every registered subscriber.
 * Called from `createFlueContext`'s `emitEvent` after the per-context
 * subscribers have run.
 */
export function dispatchGlobalEvent(event: FlueEvent, ctx: FlueContext): void {
	if (subscribers.size === 0) return;
	// Snapshot to a local array so subscribers that unsubscribe
	// themselves mid-dispatch don't perturb the iteration.
	for (const subscriber of [...subscribers]) {
		try {
			subscriber(event, ctx);
		} catch (error) {
			console.error('[flue:observe] subscriber threw:', error);
		}
	}
}
