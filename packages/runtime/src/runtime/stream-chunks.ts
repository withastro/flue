import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentSubmissionStore } from '../agent-execution-store.ts';
import type { SignalMessage } from '../types.ts';

const STREAM_FLUSH_INTERVAL_MS = 3_000;

type StreamChunkEvent = AssistantMessageEvent;

export class StreamChunkWriter {
	private pending: StreamChunkEvent[] = [];
	private segmentIndex = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing: Promise<void> | undefined;
	private failed = false;
	private active = true;

	constructor(
		private store: Pick<AgentSubmissionStore, 'appendStreamChunkSegment'>,
		readonly streamKey: string,
	) {}

	write(event: StreamChunkEvent): void {
		if (!this.active || this.failed) return;
		this.pending.push(event);
		if (!this.timer) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush().catch((err) => {
					this.failed = true;
					console.warn('[flue:stream-chunks] Throttled flush failed:', err);
				});
			}, STREAM_FLUSH_INTERVAL_MS);
		}
	}

	async flush(): Promise<void> {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.flushing) await this.flushing;
		if (this.failed || this.pending.length === 0) return;
		const events = this.pending;
		this.pending = [];
		const segmentIndex = this.segmentIndex++;
		this.flushing = this.store
			.appendStreamChunkSegment(this.streamKey, segmentIndex, JSON.stringify(events))
			.then((inserted) => {
				if (!inserted) this.failed = true;
			});
		try {
			await this.flushing;
		} catch (error) {
			this.failed = true;
			throw error;
		} finally {
			this.flushing = undefined;
		}
		// Only re-schedule if the writer is still active (not closed).
		if (this.active && this.pending.length > 0 && !this.timer && !this.failed) {
			this.timer = setTimeout(() => {
				this.timer = undefined;
				void this.flush().catch((err) => {
					this.failed = true;
					console.warn('[flue:stream-chunks] Throttled flush failed:', err);
				});
			}, STREAM_FLUSH_INTERVAL_MS);
		}
	}

	async close(): Promise<void> {
		this.active = false;
		await this.flush();
	}

	cancel(): void {
		this.active = false;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}
}

export function reconstructInterruptedStream(
	segments: Array<{ segmentIndex: number; body: string }>,
	streamKey: string,
): { partial: AssistantMessage; interrupted: SignalMessage; continued: SignalMessage } | null {
	const events = segments.flatMap((segment) => parseSegment(segment.body));
	const blocks: Array<AssistantMessage['content'][number] | undefined> = [];
	let partial: AssistantMessage | undefined;
	let sawToolCall = false;
	for (const update of events) {
		if ('partial' in update) partial = update.partial;
		if (
			update.type === 'toolcall_start' ||
			update.type === 'toolcall_delta' ||
			update.type === 'toolcall_end'
		) {
			sawToolCall = true;
			continue;
		}
		if (update.type === 'text_delta') {
			const existing = blocks[update.contentIndex];
			if (existing?.type === 'text') {
				existing.text += update.delta;
			} else {
				blocks[update.contentIndex] = { type: 'text', text: update.delta };
			}
		} else if (update.type === 'text_end') {
			const existing = blocks[update.contentIndex];
			if (existing?.type === 'text') {
				existing.text = update.content;
			} else {
				blocks[update.contentIndex] = { type: 'text', text: update.content };
			}
		} else if (update.type === 'thinking_start') {
			blocks[update.contentIndex] = { type: 'thinking', thinking: '' };
		} else if (update.type === 'thinking_delta') {
			const existing = blocks[update.contentIndex];
			if (existing?.type === 'thinking') {
				existing.thinking += update.delta;
			} else {
				blocks[update.contentIndex] = { type: 'thinking', thinking: update.delta };
			}
		} else if (update.type === 'thinking_end') {
			const existing = blocks[update.contentIndex];
			if (existing?.type === 'thinking') {
				existing.thinking = update.content;
			} else {
				blocks[update.contentIndex] = { type: 'thinking', thinking: update.content };
			}
		}
	}
	if (sawToolCall || !partial) return null;
	// Reconstructed blocks intentionally omit provider signature metadata
	// (textSignature, thinkingSignature) because stream deltas don't carry them.
	// This is safe: recovered content is rendered as signal messages (XML) for the
	// model, not sent back as provider-facing assistant blocks. If the architecture
	// changes to feed recovered content directly to the provider, signatures must
	// be preserved from the original partial AssistantMessage.
	const content = blocks.filter((block): block is AssistantMessage['content'][number] => {
		if (!block) return false;
		return block.type === 'text'
			? block.text.length > 0
			: block.type === 'thinking' && block.thinking.length > 0;
	});
	if (content.length === 0) return null;
	const recovered: AssistantMessage = {
		...partial,
		content,
		stopReason: 'aborted',
		errorMessage: 'Stream interrupted before completion.',
	};
	return {
		partial: recovered,
		interrupted: {
			role: 'signal',
			type: 'stream_interrupted',
			content: 'The previous assistant response was interrupted before completion.',
			attributes: { streamKey },
			timestamp: Date.now(),
		},
		continued: {
			role: 'signal',
			type: 'stream_continued',
			content:
				'Continue the previous assistant response from exactly where it left off. Do not repeat content already provided.',
			attributes: { streamKey },
			timestamp: Date.now(),
		},
	};
}

function parseSegment(body: string): StreamChunkEvent[] {
	try {
		const parsed = JSON.parse(body) as unknown;
		return Array.isArray(parsed) ? (parsed as StreamChunkEvent[]) : [];
	} catch {
		return [];
	}
}
