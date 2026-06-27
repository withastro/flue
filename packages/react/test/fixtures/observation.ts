import {
	type AgentConversationObservation,
	type AgentConversationObservationSnapshot,
	type FlueConversationMessage,
	type FlueConversationSettlement,
	type FlueConversationState,
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
 * drive materialized conversation snapshots directly via `emit()`; chunk
 * reduction is the SDK's responsibility and is covered there.
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

/** Builds a materialized conversation state as `observe()` would expose it. */
export function conversation(
	messages: FlueConversationMessage[] = [],
	settlements: FlueConversationSettlement[] = [],
): FlueConversationState {
	return { conversationId: 'conversation-1', messages, settlements };
}
