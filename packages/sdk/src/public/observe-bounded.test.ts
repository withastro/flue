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

const transcript = (count: number) => Array.from({ length: count }, (_, i) => message(`m${i}`));

/** Emulates the runtime's windowing over a mutable transcript. */
function windowed(
	messages: FlueConversationMessage[],
	request: { limit?: number; from?: string },
	extra: Partial<FlueConversationSnapshot> = {},
): FlueConversationSnapshot {
	const base = {
		v: 1 as const,
		conversationId: 'conv',
		offset: '1',
		incarnation: 'inc',
		settlements: [],
	};
	if (request.limit !== undefined) {
		const start = Math.max(0, messages.length - request.limit);
		return {
			...base,
			messages: messages.slice(start),
			before: start > 0 ? (messages[start]?.id ?? null) : null,
			...extra,
		};
	}
	if (request.from !== undefined) {
		const start = messages.findIndex((m) => m.id === request.from);
		if (start < 0) throw new FlueApiError(410, { error: { type: 'history_cursor_not_found' } });
		return {
			...base,
			messages: messages.slice(start),
			before: start > 0 ? (messages[start]?.id ?? null) : null,
			...extra,
		};
	}
	return { ...base, messages, ...extra };
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
	messages: FlueConversationMessage[],
	options: AgentConversationObserveOptions,
	respond: (request: { limit?: number; from?: string }) => FlueConversationSnapshot = (request) =>
		windowed(messages, request),
) {
	const historyCalls: { limit?: number; from?: string }[] = [];
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
		updates: () => {
			const stream = new FakeStream();
			streams.push(stream);
			return stream;
		},
	};
	const observation = createAgentConversationObservation(source, options);
	observation.subscribe(() => {});
	return { observation, historyCalls, streams };
}

function latest(streams: FakeStream[]): FakeStream {
	const stream = streams.at(-1);
	if (!stream) throw new Error('no updates stream opened');
	return stream;
}

const settle = () => vi.advanceTimersByTimeAsync(0);
const ids = (observation: AgentConversationObservation) =>
	observation.getSnapshot().conversation?.messages.map((m) => m.id);

beforeEach(() => {
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe('bounded observe()', () => {
	it('keeps unbounded observation unchanged', async () => {
		const { observation, historyCalls } = harness(transcript(4), {});
		await settle();
		expect(historyCalls).toEqual([{}]);
		expect(ids(observation)).toEqual(['m0', 'm1', 'm2', 'm3']);
		expect(observation.getSnapshot().conversation).not.toHaveProperty('before');
		observation.close();
	});

	it('hydrates the newest window and re-hydrates from its anchor so no gap opens', async () => {
		const messages = transcript(5);
		const { observation, historyCalls, streams } = harness(messages, { limit: 2 });
		await settle();
		expect(historyCalls).toEqual([{ limit: 2 }]);
		expect(ids(observation)).toEqual(['m3', 'm4']);
		expect(observation.getSnapshot().conversation?.before).toBe('m3');

		// Several messages land while disconnected — more than the limit.
		messages.push(message('m5'), message('m6'), message('m7'));
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls[1]).toEqual({ from: 'm3' });
		expect(ids(observation)).toEqual(['m3', 'm4', 'm5', 'm6', 'm7']);
		expect(observation.getSnapshot().conversation?.before).toBe('m3');
		observation.close();
	});

	it('re-hydrates the whole conversation once the window reaches its start', async () => {
		const messages = transcript(2);
		const { observation, historyCalls, streams } = harness(messages, { limit: 5 });
		await settle();
		expect(observation.getSnapshot().conversation?.before).toBeNull();
		messages.push(...transcript(9).slice(2));
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls[1]).toEqual({});
		expect(ids(observation)).toHaveLength(9);
		observation.close();
	});

	it('re-bases on the newest window when the anchor is gone', async () => {
		let messages = transcript(5);
		const { observation, historyCalls, streams } = harness(messages, { limit: 2 }, (request) =>
			windowed(messages, request),
		);
		await settle();
		messages = [message('n0'), message('n1'), message('n2')];
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls.slice(1)).toEqual([{ from: 'm3' }, { limit: 2 }]);
		expect(ids(observation)).toEqual(['n1', 'n2']);
		expect(observation.getSnapshot().conversation?.before).toBe('n1');
		expect(observation.getSnapshot().phase).toBe('live');
		observation.close();
	});

	it('re-bases on the newest window after an incarnation change', async () => {
		const { observation, historyCalls, streams } = harness(transcript(5), { limit: 2 });
		await settle();
		latest(streams).push({ type: 'stream-checkpoint', incarnation: 'regrown' });
		await settle();
		expect(historyCalls).toEqual([{ limit: 2 }, { limit: 2 }]);
		observation.close();
	});

	it('re-windows conversation-reset snapshots locally', async () => {
		const messages = transcript(5);
		const { observation, streams } = harness(messages, { limit: 2 });
		await settle();
		const reset = (all: FlueConversationMessage[], batch: number): ConversationStreamChunk => ({
			type: 'conversation-reset',
			conversationId: 'conv',
			snapshot: { v: 1, conversationId: 'conv', offset: '2', messages: all, settlements: [] },
			position: { batch, index: 0 },
		});
		latest(streams).push(reset([...messages, message('m5')], 1));
		await settle();
		expect(ids(observation)).toEqual(['m3', 'm4', 'm5']);
		expect(observation.getSnapshot().conversation?.before).toBe('m3');

		// A reset without the anchor (a new root conversation) re-bases.
		latest(streams).push(
			reset(
				transcript(3).map((m) => ({ ...m, id: `x${m.id}` })),
				2,
			),
		);
		await settle();
		expect(ids(observation)).toEqual(['xm1', 'xm2']);
		expect(observation.getSnapshot().conversation?.before).toBe('xm1');
		observation.close();
	});

	it('treats a runtime predating bounded history as a full read', async () => {
		const messages = transcript(4);
		const { observation, historyCalls, streams } = harness(messages, { limit: 2 }, () =>
			windowed(messages, {}),
		);
		await settle();
		expect(ids(observation)).toHaveLength(4);
		expect(observation.getSnapshot().conversation?.before).toBeNull();
		latest(streams).push(new Error('connection dropped'));
		await vi.advanceTimersByTimeAsync(1_000);
		expect(historyCalls[1]).toEqual({});
		observation.close();
	});

	it('rejects an invalid limit', () => {
		expect(() => harness([], { limit: 0 })).toThrow(/positive integer/);
		expect(() => harness([], { limit: 1.5 })).toThrow(/positive integer/);
	});
});

describe('readSubmissionReply on a bounded conversation', () => {
	it('does not fall back to an unrelated latest reply', () => {
		const assistant = message('a1', {
			role: 'assistant',
			purpose: 'assistant',
			submissionId: 'sub_new',
		});
		const settlements = [{ submissionId: 'sub_old', outcome: 'completed' as const }];
		expect(readSubmissionReply({ messages: [assistant], settlements }, 'sub_old').text).toBe('a1');
		expect(
			readSubmissionReply({ messages: [assistant], settlements, before: 'a1' }, 'sub_old').text,
		).toBe('');
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
		await client.historyBefore('m3', { limit: 10 });
		expect(Object.fromEntries((requests[0] as URL).searchParams)).toEqual({
			view: 'history',
			before: 'm3',
			limit: '10',
		});
		await client.history({ limit: 5 });
		expect(Object.fromEntries((requests[1] as URL).searchParams)).toEqual({
			view: 'history',
			limit: '5',
		});
	});

	it('rejects historyBefore() against a runtime that ignores the cursor', async () => {
		const { client } = clientServing(windowed(transcript(3), {}));
		await expect(client.historyBefore('m1')).rejects.toThrow(/bounded history/);
	});

	it('validates arguments', async () => {
		const { client } = clientServing({});
		await expect(client.history({ limit: 0 })).rejects.toThrow(/positive integer/);
		await expect(client.historyBefore('')).rejects.toThrow(/non-empty cursor/);
	});
});
