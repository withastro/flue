import {
	DurableStreamError,
	FetchError,
	type FlueClient,
	type FlueEvent,
	type FlueEventStream,
} from '@flue/sdk';

export type WorkflowStatus =
	| 'idle'
	| 'connecting'
	| 'running'
	| 'completed'
	| 'errored'
	| 'disconnected';

export interface WorkflowSnapshot {
	events: FlueEvent[];
	logs: Extract<FlueEvent, { type: 'log' }>[];
	status: WorkflowStatus;
	result: unknown;
	error: unknown;
}

export const emptyWorkflowSnapshot: WorkflowSnapshot = {
	events: [],
	logs: [],
	status: 'idle',
	result: null,
	error: undefined,
};

export class WorkflowRun {
	private snapshot: WorkflowSnapshot = { ...emptyWorkflowSnapshot };
	private listeners = new Set<() => void>();
	private stream: FlueEventStream | undefined;
	private disposed = false;
	private active = false;
	private generation = 0;
	private terminal = false;
	private reconnectOffset: string | undefined;
	private reconnectAttempt = 0;
	private reconnectWake: (() => void) | undefined;
	private seenEvents = new Set<string>();

	constructor(
		private client: FlueClient,
		private runId: string,
	) {}

	start(): void {
		if (this.active || this.terminal) return;
		this.active = true;
		this.disposed = false;
		this.generation++;
		void this.connect(this.generation);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getSnapshot = (): WorkflowSnapshot => this.snapshot;

	dispose(): void {
		if (!this.active) return;
		this.active = false;
		this.disposed = true;
		this.generation++;
		this.stream?.cancel();
		this.stream = undefined;
		this.reconnectWake?.();
		if (!this.terminal) this.update({ status: 'disconnected' });
	}

	private async connect(generation = this.generation): Promise<void> {
		if (!this.isCurrent(generation) || this.terminal || this.stream) return;
		this.update({ status: 'connecting' });
		let stream: FlueEventStream;
		try {
			stream = this.client.runs.stream(this.runId, {
				live: true,
				...(this.reconnectOffset ? { offset: this.reconnectOffset } : { offset: '-1' }),
			});
		} catch (error) {
			this.terminal = isFatal(error);
			if (this.terminal) this.update({ status: 'disconnected', error });
			else await this.retry(error, generation);
			return;
		}
		this.stream = stream;
		try {
			for await (const event of stream) {
				if (!this.isCurrent(generation)) return;
				this.reconnectAttempt = 0;
				this.consume(event);
				if (event.type === 'run_end') {
					this.terminal = true;
					stream.cancel();
					return;
				}
			}
			if (this.isCurrent(generation) && this.stream === stream)
				this.reconnectOffset = stream.offset;
			if (this.isCurrent(generation) && this.stream === stream && !this.terminal) {
				this.terminal = true;
				this.update({ status: 'disconnected' });
			}
		} catch (error) {
			if (!this.isCurrent(generation) || this.stream !== stream || this.terminal) return;
			this.reconnectOffset = stream.offset;
			if (isFatal(error)) {
				this.terminal = true;
				this.update({ status: 'disconnected', error });
				return;
			}
			await this.retry(error, generation);
		} finally {
			if (this.stream === stream) this.stream = undefined;
		}
	}

	private async retry(error: unknown, generation = this.generation): Promise<void> {
		if (!this.isCurrent(generation)) return;
		this.update({ status: 'connecting', error });
		const delay = Math.min(1000 * 2 ** this.reconnectAttempt++, 30_000);
		await new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				this.reconnectWake = undefined;
				resolve();
			}, delay);
			this.reconnectWake = () => {
				clearTimeout(timer);
				this.reconnectWake = undefined;
				resolve();
			};
		});
		if (this.isCurrent(generation)) setTimeout(() => void this.connect(generation), 0);
	}

	private isCurrent(generation: number): boolean {
		return this.active && !this.disposed && generation === this.generation;
	}

	private consume(event: FlueEvent): void {
		const eventId = `${event.runId ?? this.runId}:${event.eventIndex}`;
		if (this.seenEvents.has(eventId)) return;
		this.seenEvents.add(eventId);
		const events = [...this.snapshot.events, event];
		const logs = event.type === 'log' ? [...this.snapshot.logs, event] : this.snapshot.logs;
		if (event.type === 'run_start' || event.type === 'run_resume') {
			this.update({ events, logs, status: 'running', error: undefined });
			return;
		}
		if (event.type === 'run_end') {
			this.update({
				events,
				logs,
				status: event.isError ? 'errored' : 'completed',
				result: event.result ?? null,
				error: event.isError ? event.error : undefined,
			});
			return;
		}
		this.update({ events, logs });
	}

	private update(patch: Partial<WorkflowSnapshot>): void {
		this.snapshot = { ...this.snapshot, ...patch };
		for (const listener of this.listeners) listener();
	}
}

function isFatal(error: unknown): boolean {
	return (
		(error instanceof FetchError || error instanceof DurableStreamError) &&
		(error.status === 401 || error.status === 403 || error.status === 404)
	);
}
