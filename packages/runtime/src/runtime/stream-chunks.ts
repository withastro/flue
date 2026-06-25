import type { AssistantMessage, AssistantMessageEvent } from '@earendil-works/pi-ai';
import type { AgentSubmissionStore } from '../agent-execution-store.ts';
import { StreamChunkSegmentTooLargeError } from '../errors.ts';
import type { SignalMessage } from '../types.ts';

const STREAM_FLUSH_INTERVAL_MS = 3_000;
export const MAX_STREAM_CHUNK_SEGMENT_BYTES = 1_900_000;

const textEncoder = new TextEncoder();

type CompactPartial = Omit<
	AssistantMessage,
	'role' | 'content' | 'stopReason' | 'errorMessage'
>;
type CompactStreamEvent =
	| { type: 'text_delta'; contentIndex: number; delta: string }
	| { type: 'text_end'; contentIndex: number; content: string }
	| { type: 'thinking_start'; contentIndex: number }
	| { type: 'thinking_delta'; contentIndex: number; delta: string }
	| { type: 'thinking_end'; contentIndex: number; content: string }
	| { type: 'toolcall' };

type StoredStreamEvent = CompactStreamEvent & { partial?: CompactPartial };

export class StreamChunkWriter {
	private pending: CompactStreamEvent[] = [];
	private pendingPartial: AssistantMessage | undefined;
	private segmentIndex = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private flushing: Promise<void> | undefined;
	private failed = false;
	private active = true;

	constructor(
		private store: Pick<AgentSubmissionStore, 'appendStreamChunkSegment'>,
		readonly streamKey: string,
	) {}

	write(event: AssistantMessageEvent): void {
		if (!this.active || this.failed) return;
		this.pendingPartial =
			'partial' in event ? event.partial : event.type === 'done' ? event.message : event.error;
		const compact = compactStreamEvent(event);
		if (compact && (compact.type !== 'toolcall' || !this.pending.some(isToolCallMarker))) {
			this.pending.push(compact);
		}
		if (!this.timer && this.pending.length > 0) {
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
		if (this.failed || this.pending.length === 0 || !this.pendingPartial) return;
		const pending = this.pending;
		const partial = this.pendingPartial;
		this.pending = [];
		this.pendingPartial = undefined;
		const body = serializeStreamEvents(pending, partial);
		const serializedBytes = textEncoder.encode(body).byteLength;
		if (serializedBytes > MAX_STREAM_CHUNK_SEGMENT_BYTES) {
			this.failed = true;
			throw new StreamChunkSegmentTooLargeError({
				serializedBytes,
				maximumBytes: MAX_STREAM_CHUNK_SEGMENT_BYTES,
			});
		}
		const segmentIndex = this.segmentIndex++;
		this.flushing = this.store
			.appendStreamChunkSegment(this.streamKey, segmentIndex, body)
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
	let partial: AssistantMessage | CompactPartial | undefined;
	let sawToolCall = false;
	for (const update of events) {
		if ('partial' in update && update.partial) partial = update.partial;
		if (
			update.type === 'toolcall' ||
			update.type === 'toolcall_start' ||
			update.type === 'toolcall_delta' ||
			update.type === 'toolcall_end'
		) {
			sawToolCall = true;
			continue;
		}
		if (update.type === 'text_delta') {
			appendText(blocks, update.contentIndex, update.delta);
		} else if (update.type === 'text_end') {
			blocks[update.contentIndex] = { type: 'text', text: update.content };
		} else if (update.type === 'thinking_start') {
			blocks[update.contentIndex] = { type: 'thinking', thinking: '' };
		} else if (update.type === 'thinking_delta') {
			appendThinking(blocks, update.contentIndex, update.delta);
		} else if (update.type === 'thinking_end') {
			blocks[update.contentIndex] = { type: 'thinking', thinking: update.content };
		}
	}
	if (sawToolCall || !partial) return null;
	const content = blocks.filter((block): block is AssistantMessage['content'][number] => {
		if (!block) return false;
		return block.type === 'text'
			? block.text.length > 0
			: block.type === 'thinking' && block.thinking.length > 0;
	});
	if (content.length === 0) return null;
	const recovered: AssistantMessage = {
		...partial,
		role: 'assistant',
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

function compactStreamEvent(event: AssistantMessageEvent): CompactStreamEvent | undefined {
	switch (event.type) {
		case 'text_delta':
			return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
		case 'text_end':
			return { type: event.type, contentIndex: event.contentIndex, content: event.content };
		case 'thinking_start':
			return { type: event.type, contentIndex: event.contentIndex };
		case 'thinking_delta':
			return { type: event.type, contentIndex: event.contentIndex, delta: event.delta };
		case 'thinking_end':
			return { type: event.type, contentIndex: event.contentIndex, content: event.content };
		case 'toolcall_start':
		case 'toolcall_delta':
		case 'toolcall_end':
			return { type: 'toolcall' };
		default:
			return undefined;
	}
}

function isToolCallMarker(event: CompactStreamEvent): boolean {
	return event.type === 'toolcall';
}

function serializeStreamEvents(
	pending: CompactStreamEvent[],
	message: AssistantMessage,
): string {
	const events: StoredStreamEvent[] = [...pending];
	const last = events.at(-1);
	if (last) {
		const {
			role: _role,
			content: _content,
			stopReason: _stopReason,
			errorMessage: _errorMessage,
			...partial
		} = message;
		events[events.length - 1] = { ...last, partial };
	}
	return JSON.stringify(events);
}

function appendText(
	blocks: Array<AssistantMessage['content'][number] | undefined>,
	contentIndex: number,
	content: string,
): void {
	const existing = blocks[contentIndex];
	if (existing?.type === 'text') existing.text += content;
	else blocks[contentIndex] = { type: 'text', text: content };
}

function appendThinking(
	blocks: Array<AssistantMessage['content'][number] | undefined>,
	contentIndex: number,
	content: string,
): void {
	const existing = blocks[contentIndex];
	if (existing?.type === 'thinking') existing.thinking += content;
	else blocks[contentIndex] = { type: 'thinking', thinking: content };
}

function parseSegment(body: string): Array<AssistantMessageEvent | StoredStreamEvent> {
	try {
		const parsed = JSON.parse(body) as unknown;
		return Array.isArray(parsed) ? (parsed as Array<AssistantMessageEvent | StoredStreamEvent>) : [];
	} catch {
		return [];
	}
}
