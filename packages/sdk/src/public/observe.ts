import type { BackoffOptions, LiveMode } from '@durable-streams/client';
import type {
	AgentConversationSelector,
	AgentConversationSnapshot,
	AgentConversationState,
	AgentConversationUpdate,
} from './conversation.ts';
import {
	createAgentConversationState,
	reduceAgentConversationUpdate,
} from './conversation.ts';
import type { FlueEventStream } from './stream.ts';

export type AgentConversationObservationPhase =
	| 'loading'
	| 'connecting'
	| 'live'
	| 'up-to-date'
	| 'absent'
	| 'error'
	| 'closed';

export interface AgentConversationObservationSnapshot {
	conversation: AgentConversationState | undefined;
	offset: string | undefined;
	phase: AgentConversationObservationPhase;
	error: Error | undefined;
}

export interface AgentConversationObserveOptions extends AgentConversationSelector {
	live?: LiveMode;
	signal?: AbortSignal;
	backoffOptions?: BackoffOptions;
}

export interface AgentConversationObservation {
	getSnapshot(): AgentConversationObservationSnapshot;
	subscribe(listener: () => void): () => void;
	refresh(): void;
	close(reason?: unknown): void;
}

export interface AgentConversationObservationSource {
	history(options: AgentConversationSelector & { signal?: AbortSignal }): Promise<AgentConversationSnapshot>;
	updates(options: AgentConversationSelector & {
		offset: string;
		live?: LiveMode;
		signal?: AbortSignal;
		backoffOptions?: BackoffOptions;
	}): FlueEventStream<AgentConversationUpdate>;
}

export function createAgentConversationObservation(
	source: AgentConversationObservationSource,
	options: AgentConversationObserveOptions = {},
): AgentConversationObservation {
	const listeners = new Set<() => void>();
	const selector = conversationSelector(options);
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
	let stream: FlueEventStream<AgentConversationUpdate> | undefined;
	let retryTimer: ReturnType<typeof setTimeout> | undefined;
	let reconnectAttempt = 0;

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

	const scheduleRetry = (value: number, error: Error, resume: 'hydrate' | 'updates') => {
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
			if (resume === 'updates' && snapshot.conversation && snapshot.offset) {
				void follow(value, snapshot.offset);
			} else {
				void hydrate(value);
			}
		}, delay);
	};

	const follow = async (value: number, offset: string) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: options.live === false ? 'connecting' : 'live', error: undefined });
		let nextStream: FlueEventStream<AgentConversationUpdate>;
		try {
			nextStream = source.updates({
				...selector,
				offset,
				live: options.live,
				signal: controller?.signal,
				backoffOptions: options.backoffOptions,
			});
		} catch (error) {
			scheduleRetry(value, toError(error), 'updates');
			return;
		}
		stream = nextStream;
		try {
			for await (const update of nextStream) {
				if (!isCurrent(value) || stream !== nextStream) return;
				const conversation = snapshot.conversation;
				if (!conversation) throw new Error('Agent conversation updates require materialized state.');
				if (
					update.type === 'conversation_reset' &&
					(update.conversationId !== update.snapshot.conversationId ||
						(options.conversationId !== undefined && update.conversationId !== options.conversationId))
				) {
					throw new Error('Agent conversation reset does not match the selected conversation.');
				}
				const nextConversation = reduceAgentConversationUpdate(conversation, update);
				publish({
					conversation: nextConversation,
					offset: nextStream.offset,
					phase: options.live === false ? 'connecting' : 'live',
					error: undefined,
				});
				reconnectAttempt = 0;
			}
			if (!isCurrent(value) || stream !== nextStream) return;
			const nextOffset = nextStream.offset;
			stream = undefined;
			if (options.live === false) {
				publish({ ...snapshot, offset: nextOffset, phase: 'up-to-date', error: undefined });
				return;
			}
			scheduleRetry(value, new Error('Agent conversation stream ended unexpectedly.'), 'updates');
		} catch (error) {
			if (!isCurrent(value) || stream !== nextStream) return;
			const nextOffset = nextStream.offset;
			stream = undefined;
			if (nextOffset !== offset) snapshot = { ...snapshot, offset: nextOffset };
			scheduleRetry(value, toError(error), 'updates');
		}
	};

	const hydrate = async (value: number) => {
		if (!isCurrent(value)) return;
		publish({ ...snapshot, phase: snapshot.conversation ? 'connecting' : 'loading', error: undefined });
		try {
			const history = await source.history({ ...selector, signal: controller?.signal });
			if (!isCurrent(value)) return;
			const conversation = createAgentConversationState(history);
			reconnectAttempt = 0;
			publish({ conversation, offset: history.offset, phase: 'connecting', error: undefined });
			await follow(value, history.offset);
		} catch (error) {
			if (!isCurrent(value)) return;
			const normalized = toError(error);
			if (statusOf(error) === 404) {
				reconnectAttempt = 0;
				publish({ conversation: undefined, offset: undefined, phase: 'absent', error: undefined });
				return;
			}
			scheduleRetry(value, normalized, 'hydrate');
		}
	};

	const start = () => {
		if (started || closed) return;
		started = true;
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
		const value = generation;
		queueMicrotask(() => void hydrate(value));
	};

	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			start();
			return () => listeners.delete(listener);
		},
		refresh() {
			if (closed) return;
			clearActive();
			started = true;
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
		},
		close(reason) {
			if (closed) return;
			closed = true;
			generation++;
			clearActive();
			publish({ ...snapshot, phase: 'closed', error: reason === undefined ? undefined : toError(reason) });
			listeners.clear();
		},
	};
}

function conversationSelector(options: AgentConversationSelector): AgentConversationSelector {
	return {
		...(options.conversationId ? { conversationId: options.conversationId } : {}),
		...(options.harness ? { harness: options.harness } : {}),
		...(options.session ? { session: options.session } : {}),
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
