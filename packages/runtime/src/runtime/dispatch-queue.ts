import type { DispatchRequest } from '../types.ts';

export interface DispatchInput extends Required<DispatchRequest> {
	dispatchId: string;
	deliveryId?: string;
	sourceAgent: string;
	targetAgent: string;
	acceptedAt: string;
}

export interface DispatchReceipt {
	dispatchId: string;
	acceptedAt: string;
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
 * without changing receive()/dispatch() authoring semantics.
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
