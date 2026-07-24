/** Global, isolate-scoped subscription to live Flue runtime activity. */

import { createObservation, type FlueObservationSubscriber } from '../observation.ts';
import type { FlueEvent, FlueEventContext, FlueObservationDetail } from '../types.ts';

/**
 * Receives a decorated event and its originating context. Direct and
 * dispatched agent events carry `instanceId` and `submissionId`.
 * Subscriber failures are logged and do not halt dispatch or the originating
 * execution. Returned promises are observed for rejection but are not awaited.
 */
export type FlueEventSubscriber = FlueObservationSubscriber;

const subscribers = new Set<FlueObservationSubscriber>();

/**
 * Subscribe to live agent-interaction activity emitted in this isolate.
 * The subscription does not replay durable history or aggregate events
 * across processes or Cloudflare Durable Object isolates.
 *
 * Usage (typically at the top of `app.ts`):

 *
 *     import { observe } from '@flue/runtime';
 *
 *     observe((event, ctx) => {
 *       if (event.type === 'log' && event.level === 'error') {
 *         // ship to your error reporter, metrics sink, etc.
 *       }
 *     });
 *
 * The returned function unsubscribes the listener. Most error
 * reporting and telemetry use cases register once at startup and
 * never unsubscribe — the returned function is provided for tests
 * and dynamic-wiring scenarios.
 *
 * Subscribers are invoked synchronously from the event emit path. They should
 * treat events as read-only, remain cheap, and return quickly; returned promises
 * are observed for rejection but are not awaited. Queue substantial work outside
 * the callback rather than blocking emission.
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
export function dispatchGlobalEvent(
	event: FlueEvent,
	ctx: FlueEventContext,
	detail?: FlueObservationDetail,
): void {
	const observation = createObservation(event, detail);
	for (const subscriber of [...subscribers]) {
		try {
			Promise.resolve(subscriber(observation, ctx)).catch(reportSubscriberFailure);
		} catch (error) {
			reportSubscriberFailure(error);
		}
	}
}

function reportSubscriberFailure(error: unknown): void {
	console.error('[flue:observe] subscriber failed:', error);
}
