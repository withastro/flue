import type { AttachedAgentEvent, DirectAgentPayload, DispatchReceipt } from '../types.ts';

export interface DispatchInput {
	dispatchId: string;
	agent: string;
	id: string;
	session: string;
	input: unknown;
	acceptedAt: string;
}

export interface DirectSubmissionInput {
	submissionId: string;
	agent: string;
	id: string;
	session: string;
	payload: DirectAgentPayload;
	acceptedAt: string;
}

export type AgentSubmissionInput = DispatchInput | DirectSubmissionInput;

export interface AgentSubmissionTerminalInput {
	submissionId: string;
	kind: 'dispatch' | 'direct';
	reason: 'interrupted_before_input_marker' | 'interrupted_after_input_application';
	message: string;
}

export function assertCurrentDispatchInput(value: unknown): asserts value is DispatchInput {
	if (value && typeof value === 'object' && 'targetAgent' in value) {
		throw new Error(
			'[flue] Legacy dispatch metadata is unsupported. Clear persisted dispatch state created by an earlier Flue beta.',
		);
	}
}

export type AgentSubmissionInputInspection = 'absent' | 'applied' | 'completed' | 'advanced';
export type DispatchInputInspection = AgentSubmissionInputInspection;

export interface ProcessAgentSubmissionInputOptions {
	onInputApplied?: () => Promise<void> | void;
}

export type ProcessDispatchInputOptions = ProcessAgentSubmissionInputOptions;

export function isDispatchSubmissionInput(input: AgentSubmissionInput): input is DispatchInput {
	return 'dispatchId' in input;
}

interface AgentSubmissionObserver {
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void;
}

interface AgentSubmissionAttachment {
	readonly completion: Promise<unknown>;
	detach(): void;
}

interface AgentSubmissionObserverRegistry {
	attach(submissionId: string, observer: AgentSubmissionObserver): AgentSubmissionAttachment;
	publish(submissionId: string, event: AttachedAgentEvent): Promise<void>;
	complete(submissionId: string, result: unknown): void;
	fail(submissionId: string, error: unknown): void;
}

export type AttachedAgentSubmissionAdmission = (
	payload: DirectAgentPayload,
	request: Request,
	onEvent?: (event: AttachedAgentEvent) => Promise<void> | void,
) => Promise<unknown>;

export function createAgentSubmissionObserverRegistry(): AgentSubmissionObserverRegistry {
	const observers = new Map<string, Set<AgentSubmissionObserver & { resolve(value: unknown): void; reject(error: unknown): void }>>();
	return {
		attach(submissionId, observer) {
			let resolve!: (value: unknown) => void;
			let reject!: (error: unknown) => void;
			const completion = new Promise<unknown>((resolve_, reject_) => {
				resolve = resolve_;
				reject = reject_;
			});
			const attached = { ...observer, resolve, reject };
			const bucket = observers.get(submissionId) ?? new Set();
			bucket.add(attached);
			observers.set(submissionId, bucket);
			return {
				completion,
				detach() {
					bucket.delete(attached);
					if (bucket.size === 0) observers.delete(submissionId);
				},
			};
		},
		async publish(submissionId, event) {
			for (const observer of observers.get(submissionId) ?? []) {
				try {
					await observer.onEvent?.(event);
				} catch {}
			}
		},
		complete(submissionId, result) {
			for (const observer of observers.get(submissionId) ?? []) observer.resolve(result);
			observers.delete(submissionId);
		},
		fail(submissionId, error) {
			for (const observer of observers.get(submissionId) ?? []) observer.reject(error);
			observers.delete(submissionId);
		},
	};
}

export interface DispatchProcessor {
	process(input: DispatchInput): Promise<void> | void;
}

export interface DispatchQueue {
	enqueue(input: DispatchInput): Promise<DispatchReceipt>;
}

/**
 * Process-lifetime dispatch queue. Acceptance currently means the dispatch was
 * validated, appended to this in-memory queue, and scheduled for the configured
 * processor. Queued items are lost if the process/isolate exits before the
 * placeholder processor runs. Durable backends should implement DispatchQueue
 * without changing dispatch() authoring semantics.
 */
export class InMemoryDispatchQueue implements DispatchQueue {
	private readonly pending: DispatchInput[] = [];
	private scheduled = false;

	constructor(private readonly processor: DispatchProcessor = noopDispatchProcessor) {}

	async enqueue(input: DispatchInput): Promise<DispatchReceipt> {
		this.pending.push(input);
		this.scheduleDrain();
		return { dispatchId: input.dispatchId, acceptedAt: input.acceptedAt };
	}

	private scheduleDrain(): void {
		if (this.scheduled) return;
		this.scheduled = true;
		queueMicrotask(() => {
			this.drain().catch((error) => {
				console.error('[flue:dispatch] Dispatch processor failed:', error);
			});
		});
	}

	private async drain(): Promise<void> {
		try {
			while (this.pending.length > 0) {
				const input = this.pending.shift();
				if (!input) continue;
				try {
					await this.processor.process(input);
				} catch (error) {
					console.error('[flue:dispatch] Dispatch processor failed:', error);
				}
			}
		} finally {
			this.scheduled = false;
			if (this.pending.length > 0) this.scheduleDrain();
		}
	}
}

const noopDispatchProcessor: DispatchProcessor = {
	process() {},
};
