/** Run-history HTTP endpoints shared by the Node and Cloudflare targets. */

import { InvalidRequestError, RunNotFoundError, RunStoreUnavailableError } from '../errors.ts';
import type { FlueEvent } from '../types.ts';
import { SSE_HEARTBEAT_MS } from './handle-agent.ts';
import type { RunRecord, RunStore } from './run-store.ts';
import type { RunSubscriberRegistry } from './run-subscribers.ts';

export interface HandleRunRouteOptions {
	request: Request;
	runStore?: RunStore;
	runSubscribers?: RunSubscriberRegistry;
	agentName: string;
	id: string;
	runId?: string;
	action: 'get' | 'events' | 'stream';
}

const EVENTS_DEFAULT_LIMIT = 100;
const EVENTS_MAX_LIMIT = 1000;

/** Buffer cap for events published while a live stream is replaying history. */
const REPLAY_BUFFER_CAP = 1000;

export async function handleRunRouteRequest(opts: HandleRunRouteOptions): Promise<Response> {
	const store = opts.runStore;
	if (!store) throw new RunStoreUnavailableError();

	switch (opts.action) {
		case 'get':
			return getRun(store, requireRunId(opts.runId), opts.agentName, opts.id);
		case 'events':
			return getRunEvents(opts.request, store, requireRunId(opts.runId), opts.agentName, opts.id);
		case 'stream':
			return streamRunEvents(
				opts.request,
				store,
				opts.runSubscribers,
				requireRunId(opts.runId),
				opts.agentName,
				opts.id,
			);
	}
}

async function getRun(
	store: RunStore,
	runId: string,
	agentName: string,
	instanceId: string,
): Promise<Response> {
	const run = await getRunForInstance(store, runId, agentName, instanceId);
	return json(run);
}

async function getRunEvents(
	request: Request,
	store: RunStore,
	runId: string,
	agentName: string,
	instanceId: string,
): Promise<Response> {
	await getRunForInstance(store, runId, agentName, instanceId);
	const url = new URL(request.url);
	const after = parseEventIndex(url.searchParams.get('after'));
	const types = parseTypes(url.searchParams.get('types'));
	const limit = parseLimit(url.searchParams.get('limit'), EVENTS_DEFAULT_LIMIT, EVENTS_MAX_LIMIT);
	let events = await store.getEvents(runId, after === undefined ? undefined : after + 1);
	if (types) events = events.filter((event) => types.has(event.type));
	return json({ events: events.slice(0, limit) });
}

/**
 * Replay durable history, then tail live events for active runs.
 * Subscribe-before-replay avoids dropping events produced during the
 * store read; eventIndex dedup handles overlap.
 */
async function streamRunEvents(
	request: Request,
	store: RunStore,
	subscribers: RunSubscriberRegistry | undefined,
	runId: string,
	agentName: string,
	instanceId: string,
): Promise<Response> {
	const run = await getRunForInstance(store, runId, agentName, instanceId);

	const lastEventId = parseLastEventId(request.headers.get('last-event-id'));
	const fromIndex = lastEventId === undefined ? undefined : lastEventId + 1;

	if (isTerminal(run)) {
		const events = await store.getEvents(runId, fromIndex);
		return sseResponse(encodeSseEvents(events));
	}

	// Active streams need the in-process registry; replay alone would close early.
	if (!subscribers) {
		throw new Error(
			'[flue] Active run streaming requires a run subscriber registry, but none was ' +
				'configured for this target. Wire one through HandleRunRouteOptions.runSubscribers.',
		);
	}

	return streamReplayThenTail({ store, subscribers, runId, fromIndex });
}

interface ReplayThenTailOptions {
	store: RunStore;
	subscribers: RunSubscriberRegistry;
	runId: string;
	fromIndex: number | undefined;
}

function streamReplayThenTail(opts: ReplayThenTailOptions): Response {
	const { store, subscribers, runId, fromIndex } = opts;
	const encoder = new TextEncoder();

	// Buffered live events are deduped against the durable replay below.
	let buffer: FlueEvent[] = [];
	let bufferOverflowed = false;
	let replayDone = false;
	let lastSentIndex: number | undefined = fromIndex === undefined ? undefined : fromIndex - 1;
	let closed = false;
	let onLiveEvent: ((event: FlueEvent) => void) | undefined;
	let onClose: (() => void) | undefined;

	const subscriberListener = (event: FlueEvent) => {
		if (closed) return;
		if (!replayDone) {
			if (buffer.length >= REPLAY_BUFFER_CAP) {
				bufferOverflowed = true;
				return;
			}
			buffer.push(event);
			return;
		}
		onLiveEvent?.(event);
	};

	const unsubscribe = subscribers.subscribe(runId, subscriberListener);

	const stream = new ReadableStream<Uint8Array>({
		start(controller) {
			const heartbeat = setInterval(() => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(': heartbeat\n\n'));
				} catch {
					// Already closed — cleanup will fire from `cancel`.
				}
			}, SSE_HEARTBEAT_MS);

			const close = () => {
				if (closed) return;
				closed = true;
				clearInterval(heartbeat);
				unsubscribe();
				try {
					controller.close();
				} catch {
					// Already closed.
				}
			};
			onClose = close;

			const write = (event: FlueEvent) => {
				if (closed) return;
				try {
					controller.enqueue(encoder.encode(encodeSseEvent(event)));
				} catch {
					close();
					return;
				}
				if (typeof event.eventIndex === 'number') {
					lastSentIndex = event.eventIndex;
				}
				if (event.type === 'run_end') close();
			};

			onLiveEvent = write;

			(async () => {
				try {
					await runReplayPhase({
						store,
						runId,
						fromIndex,
						write,
						getBuffer: () => buffer,
						drainBuffer: () => {
							const drained = buffer;
							buffer = [];
							return drained;
						},
						getBufferOverflowed: () => bufferOverflowed,
						resetBufferOverflowed: () => {
							bufferOverflowed = false;
						},
						getLastSentIndex: () => lastSentIndex,
						markReplayDone: () => {
							replayDone = true;
						},
					});
				} catch (error) {
					if (closed) return;
					try {
						controller.enqueue(
							encoder.encode(encodeSseError(error, lastSentIndex)),
						);
					} catch {
						// stream already gone.
					}
					close();
				}
			})();
		},
		cancel() {
			closed = true;
			onClose?.();
		},
	});

	return sseResponse(stream);
}

interface ReplayPhaseOptions {
	store: RunStore;
	runId: string;
	fromIndex: number | undefined;
	write: (event: FlueEvent) => void;
	getBuffer: () => FlueEvent[];
	drainBuffer: () => FlueEvent[];
	getBufferOverflowed: () => boolean;
	resetBufferOverflowed: () => void;
	getLastSentIndex: () => number | undefined;
	markReplayDone: () => void;
}

async function runReplayPhase(opts: ReplayPhaseOptions): Promise<void> {
	const {
		store,
		runId,
		fromIndex,
		write,
		drainBuffer,
		getBufferOverflowed,
		resetBufferOverflowed,
		getLastSentIndex,
		markReplayDone,
	} = opts;

	const replay = await store.getEvents(runId, fromIndex);
	for (const event of replay) {
		write(event);
	}

	// If the live buffer overflowed, re-read from the store rather than
	// keeping an unbounded in-memory queue.
	while (getBufferOverflowed()) {
		resetBufferOverflowed();
		const lastSent = getLastSentIndex();
		const refetchFrom = lastSent === undefined ? undefined : lastSent + 1;
		const refetched = await store.getEvents(runId, refetchFrom);
		for (const event of refetched) {
			write(event);
		}
	}

	const buffered = drainBuffer();
	for (const event of buffered) {
		const lastSent = getLastSentIndex();
		if (
			typeof event.eventIndex === 'number' &&
			lastSent !== undefined &&
			event.eventIndex <= lastSent
		) {
			continue;
		}
		write(event);
	}

	markReplayDone();
}

async function getRunForInstance(
	store: RunStore,
	runId: string,
	agentName: string,
	instanceId: string,
): Promise<RunRecord> {
	const run = await store.getRun(runId);
	if (!run) throw new RunNotFoundError({ runId });
	if (run.agentName !== agentName || run.instanceId !== instanceId) {
		throw new RunNotFoundError({ runId });
	}
	return run;
}

function isTerminal(run: RunRecord): boolean {
	return run.status === 'completed' || run.status === 'errored';
}

function encodeSseEvents(events: FlueEvent[]): string {
	return events.map(encodeSseEvent).join('');
}

function encodeSseEvent(event: FlueEvent): string {
	const id = typeof event.eventIndex === 'number' ? event.eventIndex : 0;
	return [`event: ${event.type}`, `id: ${id}`, `data: ${JSON.stringify(event)}`, '', ''].join('\n');
}

function encodeSseError(error: unknown, lastSentIndex: number | undefined): string {
	const data = {
		message: error instanceof Error ? error.message : String(error),
	};
	const id = lastSentIndex ?? 0;
	return [`event: error`, `id: ${id}`, `data: ${JSON.stringify(data)}`, '', ''].join('\n');
}

function sseResponse(body: string | ReadableStream<Uint8Array>): Response {
	return new Response(body, {
		headers: {
			'content-type': 'text/event-stream',
			'cache-control': 'no-cache',
			connection: 'keep-alive',
		},
	});
}

function requireRunId(runId: string | undefined): string {
	if (!runId) {
		throw new InvalidRequestError({ reason: 'Run id is required for this endpoint.' });
	}
	return runId;
}

function parseTypes(value: string | null): Set<string> | undefined {
	if (!value) return undefined;
	const types = value
		.split(',')
		.map((type) => type.trim())
		.filter(Boolean);
	return types.length > 0 ? new Set(types) : undefined;
}

function parseLimit(value: string | null, defaultLimit: number, maxLimit: number): number {
	if (!value) return defaultLimit;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) return defaultLimit;
	return Math.min(parsed, maxLimit);
}

function parseEventIndex(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

/**
 * `Last-Event-ID` is the standard SSE reconnect header. Browsers send the
 * last `id:` field they saw; the server uses it to resume from that point.
 * Malformed values are ignored — equivalent to no header.
 */
function parseLastEventId(value: string | null): number | undefined {
	if (!value) return undefined;
	const parsed = Number.parseInt(value, 10);
	if (!Number.isFinite(parsed) || parsed < 0) return undefined;
	return parsed;
}

function json(data: unknown): Response {
	return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
}
