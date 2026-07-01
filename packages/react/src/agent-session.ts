import type {
	AgentConversationObservation,
	AgentPromptImage,
	ConversationLiveMode,
	FlueClient,
} from '@flue/sdk';
import {
	type AgentReducerEvent,
	type AgentSnapshot,
	type AgentState,
	emptyAgentState,
	reduceAgentEvent,
} from './agent-reducer.ts';

export interface SendMessageOptions {
	images?: AgentPromptImage[];
}

export class AgentSession {
	private state: AgentState = { ...emptyAgentState };
	private snapshot: AgentSnapshot = publicSnapshot(this.state);
	private listeners = new Set<() => void>();
	private observation: AgentConversationObservation | undefined;
	private unsubscribeObservation: (() => void) | undefined;
	private active = false;
	private localId = 0;

	constructor(
		private client: FlueClient,
		private name: string,
		private id: string,
		private live: ConversationLiveMode = 'sse',
	) {}

	start(): void {
		if (this.active) return;
		this.active = true;
		this.observation = this.client.agents.observe(this.name, this.id, { live: this.live });
		this.unsubscribeObservation = this.observation.subscribe(() => this.applyObservation());
		this.applyObservation();
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): AgentSnapshot => this.snapshot;

	/**
	 * Re-runs the observation's history catch-up and resumes live updates. Use
	 * this to re-check a conversation reported absent — its creation may be
	 * triggered out-of-band (a server-side wakeup, queue worker, or webhook) —
	 * on whatever schedule the application chooses. No-op before `start()` or
	 * after `dispose()`.
	 */
	refresh = (): void => {
		this.observation?.refresh();
	};

	async sendMessage(message: string, options: SendMessageOptions = {}): Promise<void> {
		const localId = `local:${this.name}:${this.id}:${++this.localId}`;
		this.dispatch({ type: 'local_send_submitted', localId, message, images: options.images });
		try {
			const receipt = await this.client.agents.send(this.name, this.id, {
				message,
				images: options.images,
			});
			this.dispatch({ type: 'local_send_admitted', localId, submissionId: receipt.submissionId });
			if (this.observation?.getSnapshot().phase === 'absent') this.observation.refresh();
		} catch (error) {
			const normalized = toError(error);
			this.dispatch({ type: 'local_send_failed', localId, error: normalized });
			throw error;
		}
	}

	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.unsubscribeObservation?.();
		this.unsubscribeObservation = undefined;
		this.observation?.close();
		this.observation = undefined;
	}

	private applyObservation(): void {
		const observed = this.observation?.getSnapshot();
		if (!observed) return;
		this.dispatch({
			type: 'local_observation',
			conversation: observed.conversation,
			phase: observed.phase,
			error: observed.error,
		});
	}

	private dispatch(event: AgentReducerEvent): void {
		const next = reduceAgentEvent(this.state, event);
		if (next === this.state) return;
		this.state = next;
		this.publish();
	}

	private publish(): void {
		this.snapshot = publicSnapshot(this.state);
		for (const listener of this.listeners) listener();
	}
}

function publicSnapshot(state: AgentState): AgentSnapshot {
	return {
		messages: state.messages,
		status: state.status,
		historyReady: state.historyReady,
		error: state.error,
		failedSends: state.failedSends,
	};
}

function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
