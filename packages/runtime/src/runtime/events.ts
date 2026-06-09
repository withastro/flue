/** Global, isolate-scoped subscription to live Flue runtime activity. */

import type { FlueContext, FlueEvent } from '../types.ts';

/**
 * Receives a decorated event snapshot and its originating context. Workflow
 * events may carry `runId`; direct and dispatched agent events carry
 * `instanceId` and optional `dispatchId` without becoming workflow runs.
 * Subscriber failures are logged and do not halt dispatch or the originating
 * execution. Returned promises are observed for rejection but are not awaited.
 */
export type FlueEventSubscriber = (event: FlueEvent, ctx: FlueContext) => void | Promise<void>;

const subscribers = new Set<FlueEventSubscriber>();

/**
 * Subscribe to live workflow-run or agent-interaction activity emitted in this isolate.
 * The subscription does not replay durable workflow history or aggregate events
 * across processes or Cloudflare Durable Object isolates.
 *
 * Usage (typically at the top of `app.ts`):

 *
 *     import { observe } from '@flue/runtime';
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
 * Subscribers are invoked synchronously from the event emit path with an
 * isolated JSON snapshot. They should be cheap and side-effect-only; returned
 * promises are observed for rejection but are not awaited. Queue substantial
 * work outside the callback rather than blocking emission.
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
	let serializedEvent: string | undefined;
	try {
		serializedEvent = JSON.stringify(event);
		if (serializedEvent === undefined)
			throw new Error('Event snapshot serialization returned undefined.');
	} catch (error) {
		reportSubscriberFailure(error);
		return;
	}
	// Snapshot to a local array so subscribers that unsubscribe
	// themselves mid-dispatch don't perturb the iteration.
	for (const subscriber of Array.from(subscribers)) {
		try {
			Promise.resolve(subscriber(JSON.parse(serializedEvent) as FlueEvent, ctx)).catch(
				reportSubscriberFailure,
			);
		} catch (error) {
			reportSubscriberFailure(error);
		}
	}
}

function reportSubscriberFailure(error: unknown): void {
	console.error('[flue:observe] subscriber failed:', error);
}
