import {
	type AgentPromptImage,
	type FlueConversationMessage,
	type FlueConversationState,
} from '@flue/sdk';

export type AgentStatus = 'idle' | 'connecting' | 'submitted' | 'streaming' | 'error';

/** One locally-submitted message whose send failed, retained for retry UIs. */
export interface FailedSend {
	/** Id of the retained optimistic message in `messages` (the local id). */
	id: string;
	/** The text the user tried to send. */
	message: string;
	error: Error;
}

export interface AgentSnapshot {
	messages: FlueConversationMessage[];
	status: AgentStatus;
	historyReady: boolean;
	error: Error | undefined;
	/**
	 * Sends that failed before the server accepted them. Their optimistic
	 * messages remain in `messages` (keyed by `id`) so a UI can show them with a
	 * retry affordance instead of having them silently disappear.
	 */
	failedSends: FailedSend[];
}

interface PendingSend {
	localId: string;
	submissionId?: string;
	optimistic: FlueConversationMessage;
}

export interface AgentState extends AgentSnapshot {
	conversation: FlueConversationState | undefined;
	pendingSends: PendingSend[];
	/** Optimistic messages for failed sends, retained so they stay rendered. */
	failedOptimistic: FlueConversationMessage[];
	/**
	 * Maps a submission id to the local id its optimistic message used. The
	 * canonical user message that later arrives is re-keyed to this local id so
	 * the row identity is stable across the optimistic→confirmed transition
	 * (otherwise a keyed/virtualized list sees remove+add and loses scroll/focus).
	 */
	localMessageIds: { submissionId: string; localId: string }[];
	localSubmissionIds: string[];
	activeSubmissionIds: string[];
}

export const emptyAgentState: AgentState = {
	messages: [],
	status: 'idle',
	historyReady: false,
	error: undefined,
	failedSends: [],
	conversation: undefined,
	pendingSends: [],
	failedOptimistic: [],
	localMessageIds: [],
	localSubmissionIds: [],
	activeSubmissionIds: [],
};

export type AgentReducerEvent =
	| { type: 'local_send_submitted'; localId: string; message: string; images?: AgentPromptImage[] }
	| { type: 'local_send_admitted'; localId: string; submissionId: string }
	| { type: 'local_send_failed'; localId: string; error: Error }
	| {
			type: 'local_observation';
			conversation: FlueConversationState | undefined;
			phase: 'loading' | 'connecting' | 'live' | 'up-to-date' | 'absent' | 'error' | 'closed';
			error?: Error;
	  };

export function reduceAgentEvent(state: AgentState, event: AgentReducerEvent): AgentState {
	switch (event.type) {
		case 'local_send_submitted': {
			const settledIds = new Set(
				state.conversation?.settlements.map((settlement) => settlement.submissionId) ?? [],
			);
			return converge({
				...state,
				pendingSends: [
					...state.pendingSends,
					{ localId: event.localId, optimistic: optimisticMessage(event) },
				],
				localSubmissionIds: state.localSubmissionIds.filter((id) => !settledIds.has(id)),
				error: undefined,
			});
		}
		case 'local_send_admitted':
			return converge({
				...state,
				pendingSends: state.pendingSends.map((send) =>
					send.localId === event.localId ? { ...send, submissionId: event.submissionId } : send,
				),
				localMessageIds: [
					...state.localMessageIds,
					{ submissionId: event.submissionId, localId: event.localId },
				],
				localSubmissionIds: addUnique(state.localSubmissionIds, event.submissionId),
				activeSubmissionIds: addUnique(state.activeSubmissionIds, event.submissionId),
			});
		case 'local_send_failed': {
			const failed = state.pendingSends.find((send) => send.localId === event.localId);
			return converge({
				...state,
				pendingSends: state.pendingSends.filter((send) => send.localId !== event.localId),
				...(failed
					? {
							failedOptimistic: [...state.failedOptimistic, failed.optimistic],
							failedSends: [
								...state.failedSends,
								{ id: failed.localId, message: messageText(failed.optimistic), error: event.error },
							],
						}
					: {}),
			});
		}
		case 'local_observation': {
			if (event.phase === 'error') return { ...state, status: 'error', error: event.error };
			if (event.phase === 'absent') {
				return converge({ ...state, conversation: undefined, historyReady: true });
			}
			if (event.conversation) {
				const merged = converge({ ...state, conversation: event.conversation, historyReady: true });
				return event.phase === 'loading' || event.phase === 'connecting'
					? { ...merged, status: merged.status === 'idle' ? 'connecting' : merged.status, error: event.error }
					: merged;
			}
			return {
				...state,
				status: event.phase === 'loading' || event.phase === 'connecting' ? 'connecting' : state.status,
				error: event.error,
			};
		}
	}
}

function converge(state: AgentState): AgentState {
	const conversation = state.conversation;
	const settledIds = new Set(conversation?.settlements.map((settlement) => settlement.submissionId) ?? []);
	const localIdBySubmissionId = new Map(
		state.localMessageIds.map((entry) => [entry.submissionId, entry.localId] as const),
	);

	// Re-key each canonical message that originated from a local send back to the
	// id its optimistic echo used, so the rendered row is stable across the
	// optimistic→confirmed swap.
	const canonical = (conversation?.messages ?? []).map((message) => {
		const localId = message.submissionId ? localIdBySubmissionId.get(message.submissionId) : undefined;
		return localId ? { ...message, id: localId } : message;
	});
	const canonicalSubmissionIds = new Set(
		(conversation?.messages ?? [])
			.map((message) => message.submissionId)
			.filter((value): value is string => typeof value === 'string'),
	);

	// Keep showing an optimistic echo until its canonical copy (or settlement)
	// arrives; once it does, the re-keyed canonical message takes its place.
	const pendingSends: PendingSend[] = [];
	const pendingEchoes: FlueConversationMessage[] = [];
	for (const pending of state.pendingSends) {
		const confirmed = pending.submissionId
			? canonicalSubmissionIds.has(pending.submissionId) || settledIds.has(pending.submissionId)
			: false;
		if (confirmed) continue;
		pendingSends.push(pending);
		pendingEchoes.push(pending.optimistic);
	}

	const messages = [...canonical, ...pendingEchoes, ...state.failedOptimistic];

	const ownStreaming = (conversation?.messages ?? []).some(
		(message) =>
			message.role === 'assistant' &&
			message.parts.some(
				(part) => (part.type === 'text' || part.type === 'reasoning') && part.state === 'streaming',
			),
	);
	const failedSettlement = conversation?.settlements.find(
		(settlement) =>
			settlement.outcome === 'failed' && state.localSubmissionIds.includes(settlement.submissionId),
	);
	const activeSubmissionIds = state.activeSubmissionIds.filter((id) => !settledIds.has(id));
	const hasFailedSend = state.failedSends.length > 0;

	const status: AgentStatus = failedSettlement
		? 'error'
		: ownStreaming
			? 'streaming'
			: pendingSends.length > 0
				? 'submitted'
				: activeSubmissionIds.length > 0
					? 'streaming'
					: hasFailedSend
						? 'error'
						: 'idle';

	return {
		...state,
		messages,
		pendingSends,
		activeSubmissionIds,
		status,
		error: failedSettlement
			? new Error(settlementError(failedSettlement.error))
			: status === 'error' && hasFailedSend
				? state.failedSends[state.failedSends.length - 1]?.error
				: undefined,
	};
}

function optimisticMessage(
	event: Extract<AgentReducerEvent, { type: 'local_send_submitted' }>,
): FlueConversationMessage {
	return {
		id: event.localId,
		role: 'user',
		parts: [
			{ type: 'text', text: event.message, state: 'done' },
			// Opaque attachment reference. The optimistic echo has no durable
			// attachment id yet (bytes are not persisted until the server records
			// them), so it carries only the media type — consistent with the
			// canonical projection after round-trip.
			...(event.images ?? []).map((image) => ({
				type: 'file' as const,
				mediaType: image.mimeType,
			})),
		],
	};
}

function messageText(message: FlueConversationMessage): string {
	const part = message.parts.find((value) => value.type === 'text');
	return part && part.type === 'text' ? part.text : '';
}

function addUnique(values: string[], value: string): string[] {
	return values.includes(value) ? values : [...values, value];
}

function settlementError(value: unknown): string {
	if (value && typeof value === 'object' && 'message' in value) return String(value.message);
	return 'Agent submission failed';
}
