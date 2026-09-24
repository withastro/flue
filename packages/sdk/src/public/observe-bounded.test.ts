import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFlueClient } from '../client.ts';
import { FlueApiError } from '../http.ts';
import type { FlueConversationMessage, FlueConversationSnapshot } from './conversation.ts';
import type { ConversationStreamChunk } from './conversation-stream.ts';
import {
	type AgentConversationObservation,
	type AgentConversationObservationSource,
	type AgentConversationObserveOptions,
	createAgentConversationObservation,
} from './observe.ts';
import { readSubmissionReply } from './reply.ts';
import type { FlueEventStream } from './stream.ts';

function message(
	id: string,
	extra: Partial<FlueConversationMessage> = {},
): FlueConversationMessage {
	return {
		id,
		role: 'user',
		purpose: 'user',
		display: 'visible',
		parts: [{ type: 'text', text: id, state: 'done' }],
		...extra,
	};
}

const transcript = (count: number, prefix = 'm') =>
	Array.from({ length: count }, (_, i) => message(`${prefix}${i}`));

/**
 * Stand-in for the runtime's opaque cursor: bound to a generation and a
 * message. The SDK must never parse it — these tests would fail if it did.
 */
const cursor = (incarnation: string, id: string) => `opaque:${incarnation}:${id}`;

/** Emulates the runtime's windowing over a mutable transcript and generation. */
class FakeRuntime {
	constructor(
		public messages: FlueConversationMessage[],
		public incarnation = 'gen_a',
	) {}

	read(request: { limit?: number; from?: string }): FlueConversationSnapshot {
		const base = {
			v: 1 as const,
			conversationId: 'conv',
			offset: '1',
			incarnation: this.incarnation,
			settlements: [],
		};
		let start: number;
		if (request.limit !== undefined) {
			start = Math.max(0, this.messages.length - request.limit);
		} else if (request.from !== undefined) {
			start = this.messages.findIndex((m) => cursor(this.incarnation, m.id) === request.from);
			if (start < 0) throw new FlueApiError(410, { error: { type: 'history_cursor_not_found' } });
		} else {
			return { ...base, messages: this.messages };
		}
		return { ...base, messages: this.messages.slice(start), before: this.cursorAt(start) };
	}

	cursorAt(start: number): string | null {
		const oldest = this.messages[start];
		return start > 0 && oldest ? cursor(this.incarnation, oldest.id) : null;
	}
}

/** A manually driven updates stream. */
class FakeStream implements FlueEventStream<ConversationStreamChunk> {
	offset = '1';
	private queue: (ConversationStreamChunk | Error | 'end')[] = [];
	private wake: (() => void) | undefined;
	cancelled = false;
	push(item: ConversationStreamChunk | Error | 'end') {
		this.queue.push(item);
		this.wake?.();
	}
	cancel() {
		this.cancelled = true;
		this.push('end');
	}
	async *[Symbol.asyncIterator]() {
		while (true) {
			const next = this.queue.shift();
			if (next === undefined) {
				await new Promise<void>((resolve) => {
					this.wake = resolve;
				});
				continue;
			}
			if (next === 'end') return;
			if (next instanceof Error) throw next;
			yield next;
		}
	}
}

function harness(
	runtime: FakeRuntime,
	options: AgentConversationObserveOptions,
	respond: (request: { limit?: number; from?: string }) => FlueConversationSnapshot = (request) =>
		runtime.read(request),
) {
	const historyCalls: { limit?: number; from?: string }[] = [];
	const updateWindows: unknown[] = [];
	const streams: FakeStream[] = [];
	const source: AgentConversationObservationSource = {
		history: async ({ limit, from }) => {
			const request = {
				...(limit !== undefined ? { limit } : {}),
				...(from !== undefined ? { from } : {}),
			};
			historyCalls.push(request);
			return respond(request);
		},
		updates: ({ window }) => {
			updateWindows.push(window);
			const stream = new FakeStream();
			streams.push(stream);
			return stream;
		},
	};
	const observation = createAgentConversationObservation(source, options);
	observation.subscribe(() => {});
	return { observation, historyCalls, updateWindows, streams };
}

function latest(streams: FakeStream[]): FakeStream {
	const stream = streams.at(-1);
	if (!stream) throw new Error('no updates stream opened');
	return stream;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const ids = (observation: AgentConversationObservation) =>
	observation.getSnapshot().conversation?.messages.map((m) => m.id);
const cursorOf = (observation: AgentConversationObservation) =>
	observation.getSnapshot().conversation?.before;
const reset = (
	snapshot: Partial<FlueConversationSnapshot> & { messages: FlueConversationMessage[] },
	batch: number,
): ConversationStreamChunk => ({
	type: 'conversation-reset',
	conversationId: 'conv',
	snapshot: { v: 1, conversationId: 'conv', offset: '2', settlements: [], ...snapshot },
	position: { batch, index: 0 },
});

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('bounded observe()', () => {
	it('keeps unbounded observation unchanged', async () => {
		const { observation, historyCalls, updateWindows } = harness(
			new FakeRuntime(transcript(4)),
			{},
		);
		await settle();
		expect(historyCalls).toEqual([{}]);
		expect(updateWindows).toEqual([undefined]);
		expect(ids(observation)).toEqual(['m0', 'm1', 'm2', 'm3']);
		expect(observation.getSnapshot().conversation).not.toHaveProperty('before');
		observation.close();
	});

	it('hydrates the newest window and re-hydrates from its anchor so no gap opens', async () => {
		const runtime = new FakeRuntime(transcript(5));
		const { observation, historyCalls, updateWindows, streams } = harness(runtime, { limit: 2 });
		await settle();
		expect(historyCalls).toEqual([{ limit: 2 }]);
		expect(ids(observation)).toEqual(['m3', 'm4']);
		const anchor = cursor('gen_a', 'm3');
		expect(cursorOf(observation)).toBe(anchor);
		// The updates stream carries the window so the runtime can cut resets.
		expect(updateWindows).toEqual([{ from: anchor, limit: 2 }]);

		// More messages than the limit land while disconnected.
		runtime.messages.push(message('m5'), message('m6'), message('m7'));
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls[1]).toEqual({ from: anchor });
		expect(ids(observation)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
		expect(cursorOf(observation)).toBe(anchor);
		observation.close();
	});

	it('re-hydrates the whole conversation once the window reaches its start', async () => {
		const runtime = new FakeRuntime(transcript(2));
		const { observation, historyCalls, updateWindows, streams } = harness(runtime, { limit: 5 });
		await settle();
		expect(cursorOf(observation)).toBeNull();
		expect(updateWindows).toEqual([undefined]);
		runtime.messages = transcript(9);
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls[1]).toEqual({});
		expect(ids(observation)).toHaveLength(9);
		observation.close();
	});

	it('re-bases when the stream was reset while disconnected, even with repeated ids', async () => {
		const runtime = new FakeRuntime(transcript(5));
		const { observation, historyCalls, streams } = harness(runtime, { limit: 2 });
		await settle();
		const first = cursorOf(observation);
		// A regrown generation with the same deterministic ids.
		runtime.incarnation = 'gen_b';
		runtime.messages = transcript(6);
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls.slice(1)).toEqual([{ from: first }, { limit: 2 }]);
		expect(ids(observation)).toEqual(['m4', 'm5']);
		// The changed cursor is the signal to discard older pages.
		expect(cursorOf(observation)).toBe(cursor('gen_b', 'm4'));
		expect(cursorOf(observation)).not.toBe(first);
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('re-bases when an anchored read resolves in a different generation', async () => {
		// Defense in depth: a runtime answering `from` across generations.
		const runtime = new FakeRuntime(transcript(5));
		let calls = 0;
		const { observation, historyCalls, streams } = harness(runtime, { limit: 2 }, (request) => {
			calls++;
			if (calls === 2) return { ...runtime.read({ limit: 3 }), incarnation: 'gen_b' };
			return runtime.read(request);
		});
		await settle();
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls.slice(1)).toEqual([{ from: cursor('gen_a', 'm3') }, { limit: 2 }]);
		expect(ids(observation)).toEqual(['m3', 'm4']);
		observation.close();
	});

	it('re-bases on the newest window after an incarnation change', async () => {
		const { observation, historyCalls, streams } = harness(new FakeRuntime(transcript(5)), {
			limit: 2,
		});
		await settle();
		latest(streams).push({ type: 'stream-checkpoint', incarnation: 'regrown' });
		await settle();
		expect(historyCalls).toEqual([{ limit: 2 }, { limit: 2 }]);
		observation.close();
	});

	it('accepts a reset the runtime already cut to the window', async () => {
		const runtime = new FakeRuntime(transcript(5));
		const { observation, historyCalls, streams } = harness(runtime, { limit: 2 });
		await settle();
		const anchor = cursor('gen_a', 'm3');
		latest(streams).push(
			reset({ messages: [message('m3'), message('m4'), message('m5')], before: anchor }, 1),
		);
		await settle();
		expect(ids(observation)).toEqual(['m3', 'm4', 'm5']);
		expect(cursorOf(observation)).toBe(anchor);
		expect(historyCalls).toHaveLength(1);
		observation.close();
	});

	it('re-bases when a server-cut reset no longer matches the window', async () => {
		const runtime = new FakeRuntime(transcript(5));
		const { observation, historyCalls, streams } = harness(runtime, { limit: 2 });
		await settle();
		latest(streams).push(reset({ messages: transcript(2, 'x'), before: cursor('gen_a', 'x0') }, 1));
		await settle();
		expect(historyCalls).toEqual([{ limit: 2 }, { limit: 2 }]);
		observation.close();
	});

	it('cuts a whole-transcript reset locally at the oldest held message', async () => {
		// A runtime that cannot window resets sends the whole transcript.
		const runtime = new FakeRuntime(transcript(5));
		const { observation, historyCalls, streams } = harness(runtime, { limit: 2 });
		await settle();
		latest(streams).push(reset({ messages: [...transcript(5), message('m5')] }, 1));
		await settle();
		expect(ids(observation)).toEqual(['m3', 'm4', 'm5']);
		expect(cursorOf(observation)).toBe(cursor('gen_a', 'm3'));
		expect(historyCalls).toHaveLength(1);

		// Without the anchor (a new root conversation) it re-bases.
		latest(streams).push(reset({ messages: transcript(3, 'x') }, 2));
		await settle();
		expect(historyCalls).toEqual([{ limit: 2 }, { limit: 2 }]);
		observation.close();
	});

	it('treats a runtime predating bounded history as a full read', async () => {
		const runtime = new FakeRuntime(transcript(4));
		const { observation, historyCalls, streams } = harness(runtime, { limit: 2 }, () =>
			runtime.read({}),
		);
		await settle();
		expect(ids(observation)).toHaveLength(4);
		expect(cursorOf(observation)).toBeNull();
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls[1]).toEqual({});
		observation.close();
	});

	it('rejects an invalid limit', () => {
		expect(() => harness(new FakeRuntime([]), { limit: 0 })).toThrow(/positive integer/);
		expect(() => harness(new FakeRuntime([]), { limit: 1.5 })).toThrow(/positive integer/);
	});
});

describe('readSubmissionReply on bounded conversations', () => {
	const assistant = message('a1', {
		role: 'assistant',
		purpose: 'assistant',
		submissionId: 'sub_new',
	});
	const settlements = [{ submissionId: 'sub_old', outcome: 'completed' as const }];

	it('falls back to the latest reply only on a complete head', () => {
		expect(readSubmissionReply({ messages: [assistant], settlements }, 'sub_old').text).toBe('a1');
		// A bounded head that reaches the start is complete.
		expect(
			readSubmissionReply({ messages: [assistant], settlements, before: null }, 'sub_old').text,
		).toBe('a1');
	});

	it('does not fall back on a window with older messages unloaded', () => {
		expect(
			readSubmissionReply({ messages: [assistant], settlements, before: 'cursor' }, 'sub_old').text,
		).toBe('');
	});

	it('does not fall back on the oldest history page', () => {
		// Statically rejected (pages carry no settlements); guarded at runtime too.
		const page = { v: 1, conversationId: 'conv', messages: [assistant], before: null };
		expect(readSubmissionReply(page as never, 'sub_missing').text).toBe('');
	});
});

describe('client history pagination', () => {
	function clientServing(body: unknown) {
		const requests: URL[] = [];
		const client = createFlueClient({
			url: 'https://flue.test/agents/echo/1',
			fetch: async (input) => {
				requests.push(new URL(String(input)));
				return Response.json(body);
			},
		});
		return { client, requests };
	}

	it('sends limit and before on the history view', async () => {
		const { client, requests } = clientServing({
			v: 1,
			conversationId: 'conv',
			messages: [],
			before: null,
		});
		await client.historyBefore('opaque', { limit: 10 });
		expect(Object.fromEntries((requests[0] as URL).searchParams)).toEqual({
			view: 'history',
			before: 'opaque',
			limit: '10',
		});
		await client.history({ limit: 5 });
		expect(Object.fromEntries((requests[1] as URL).searchParams)).toEqual({
			view: 'history',
			limit: '5',
		});
	});

	it('rejects historyBefore() against a runtime that ignores the cursor', async () => {
		const { client } = clientServing(new FakeRuntime(transcript(3)).read({}));
		await expect(client.historyBefore('opaque', { limit: 5 })).rejects.toThrow(/bounded history/);
	});

	it('requires a page size and a cursor', async () => {
		const { client } = clientServing({});
		await expect(client.history({ limit: 0 })).rejects.toThrow(/positive integer/);
		await expect(client.historyBefore('', { limit: 5 })).rejects.toThrow(/non-empty cursor/);
		await expect(client.historyBefore('opaque', {} as never)).rejects.toThrow(/positive integer/);
		await expect(client.historyBefore('opaque', { limit: 0 })).rejects.toThrow(/positive integer/);
	});
});
