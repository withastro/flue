import {
	type AgentConversationObservation,
	type AgentConversationObservationSnapshot,
	type AgentConversationSnapshot,
	type AgentConversationState,
	type AgentConversationUpdate,
	createAgentConversationState,
	reduceAgentConversationUpdate,
} from '@flue/sdk';
import { type Mock, vi } from 'vitest';

export interface FakeObservation extends AgentConversationObservation {
	/** Drives a new observation snapshot through to subscribers. */
	emit(snapshot: AgentConversationObservationSnapshot): void;
	refresh: Mock<() => void>;
	close: Mock<(reason?: unknown) => void>;
}

/**
 * Minimal stand-in for the SDK observation injected into AgentSession. Tests
 * drive materialized conversation snapshots directly via `emit()`; reduction
 * itself is the SDK's responsibility and is covered there.
 */
export function createFakeObservation(
	initial: AgentConversationObservationSnapshot = {
		conversation: undefined,
		offset: undefined,
		phase: 'loading',
		error: undefined,
	},
): FakeObservation {
	let snapshot = initial;
	const listeners = new Set<() => void>();
	return {
		getSnapshot: () => snapshot,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		refresh: vi.fn<() => void>(),
		close: vi.fn<(reason?: unknown) => void>(),
		emit(next) {
			snapshot = next;
			for (const listener of listeners) listener();
		},
	};
}

/** Builds a materialized conversation state from a snapshot and live records. */
export function materialize(
	snapshot: AgentConversationSnapshot,
	updates: AgentConversationUpdate[] = [],
): AgentConversationState {
	let state = createAgentConversationState(snapshot);
	for (const update of updates) state = reduceAgentConversationUpdate(state, update);
	return state;
}
