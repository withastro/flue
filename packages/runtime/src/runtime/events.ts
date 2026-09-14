/** Global, isolate-scoped subscription to live Flue runtime activity. */

import { createObservation, type FlueObservationSubscriber } from '../observation.ts';
import type {
	FlueEvent,
	FlueEventContext,
	FlueEventInput,
	FlueObservationDetail,
} from '../types.ts';

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
 * Async subscriber deliveries still in flight. Emission never awaits them
 * (a slow subscriber must not block the emit path), but the set lets an
 * invocation boundary hand them to the platform —
 * {@link drainGlobalEventDeliveries} — so a settlement emitted in an alarm
 * invocation's final moments isn't torn down mid-POST on Cloudflare.
 */
const inFlightDeliveries = new Set<Promise<unknown>>();

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
			const delivery = Promise.resolve(subscriber(observation, ctx)).catch(reportSubscriberFailure);
			inFlightDeliveries.add(delivery);
			void delivery.finally(() => inFlightDeliveries.delete(delivery));
		} catch (error) {
			reportSubscriberFailure(error);
		}
	}
}

/**
 * Internal: settle every subscriber delivery in flight at call time. Never
 * rejects (failures were already contained and logged per delivery). Handed
 * to `ctx.waitUntil` at Cloudflare invocation boundaries; a no-op when
 * nothing is pending.
 */
export function drainGlobalEventDeliveries(): Promise<void> {
	if (inFlightDeliveries.size === 0) return Promise.resolve();
	return Promise.allSettled([...inFlightDeliveries]).then(() => undefined);
}

function reportSubscriberFailure(error: unknown): void {
	console.error('[flue:observe] subscriber failed:', error);
}

/** Emit one live event onto the `observe()` stream from coordinator code. */
export type CoordinatorEventEmitter = (
	event: FlueEventInput,
	detail?: FlueObservationDetail,
) => void;

/**
 * Internal: a context-free event emitter for the submission coordinators —
 * the emission path for events that must not depend on the machinery they
 * report on (`submission_queued`, `submission_recovery`, and the recovered
 * live `submission_settled`), because "context/writer creation failed" is one
 * of the failures being reported. It stamps the delivered envelope (`v`, its
 * own monotonic `eventIndex`, `timestamp`, the scope's correlation fields),
 * builds a minimal {@link FlueEventContext} (`req: undefined`, `log` backed
 * by the same emitter), and dispatches to the global `observe()` subscribers.
 *
 * Infallible by contract: the emitter body can never throw into a recovery
 * catch block — a failure signal must not be able to worsen the failure it
 * reports. (Subscriber exceptions are already contained by
 * {@link dispatchGlobalEvent}; this guards the envelope stamping itself.)
 */
export function createCoordinatorEventEmitter(scope: {
	agentName?: string;
	instanceId?: string;
	env: Record<string, unknown>;
}): CoordinatorEventEmitter {
	let eventIndex = 0;
	const emit: CoordinatorEventEmitter = (event, detail) => {
		try {
			const decorated: FlueEvent = {
				...event,
				...(scope.instanceId === undefined ? {} : { instanceId: scope.instanceId }),
				...(scope.agentName === undefined ? {} : { agentName: scope.agentName }),
				v: 3,
				eventIndex: eventIndex++,
				timestamp: new Date().toISOString(),
			};
			dispatchGlobalEvent(decorated, ctx, detail);
		} catch (error) {
			try {
				reportSubscriberFailure(error);
			} catch {
				// Nothing further to do — the emitter must never throw.
			}
		}
	};
	const log = (level: 'info' | 'warn' | 'error') => {
		return (message: string, attributes?: Record<string, unknown>) => {
			emit({ type: 'log', level, message, ...(attributes ? { attributes } : {}) });
		};
	};
	const ctx: FlueEventContext = {
		id: scope.instanceId ?? '',
		agentName: scope.agentName,
		env: scope.env,
		req: undefined,
		log: { info: log('info'), warn: log('warn'), error: log('error') },
	};
	return emit;
}
