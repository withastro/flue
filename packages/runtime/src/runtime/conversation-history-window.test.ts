import { describe, expect, it } from 'vitest';
import type { AgentConversationSnapshot } from '../conversation-public.ts';
import { HistoryCursorNotFoundError, InvalidRequestError } from '../errors.ts';
import {
	applyHistoryWindow,
	applyResetWindow,
	encodeHistoryCursor,
	type HistoryWindow,
	parseHistoryWindow,
	parseResetWindow,
	type ResetWindow,
} from './conversation-history-window.ts';

function snapshot(count: number): AgentConversationSnapshot {
	return {
		v: 1,
		conversationId: 'conv',
		offset: '42',
		messages: Array.from({ length: count }, (_, index) => ({
			id: `m${index}`,
			role: 'user' as const,
			purpose: 'user' as const,
			display: 'visible' as const,
			parts: [{ type: 'text' as const, text: `message ${index}`, state: 'done' as const }],
		})),
		settlements: [{ submissionId: 'sub_0', outcome: 'completed' }],
	};
}

const gen = 'gen_a';
const cursor = (messageId: string, incarnation = gen) =>
	encodeHistoryCursor(incarnation, messageId);
const context = (liveTargets: string[] = []) => ({
	incarnation: gen,
	liveTargets: new Set(liveTargets),
});
const ids = (value: { messages: { id: string }[] }) => value.messages.map((message) => message.id);
const url = (query: string) => new URL(`https://flue.test/c?${query}`);
const parse = (query: string) => parseHistoryWindow(url(query)) as HistoryWindow;
const apply = (count: number, query: string, live: string[] = []) =>
	applyHistoryWindow(snapshot(count), parse(query), context(live));

describe('history cursors', () => {
	it('are opaque, deterministic, and URL-safe', () => {
		const token = cursor('entry_é/+');
		expect(token).toBe(cursor('entry_é/+'));
		expect(token).toMatch(/^hc1\.[A-Za-z0-9_-]+$/);
		expect(token).not.toContain('entry_');
		expect(cursor('m1', 'gen_b')).not.toBe(cursor('m1'));
	});

	it('round-trip through a query string', () => {
		expect(parse(`from=${cursor('entry_é')}`)).toMatchObject({
			kind: 'from',
			cursor: { incarnation: gen, messageId: 'entry_é' },
		});
	});
});

describe('parseHistoryWindow', () => {
	it('reads no bounds as the full conversation', () => {
		expect(parse('view=history')).toEqual({ kind: 'full' });
	});

	it('parses limit, before, and from', () => {
		expect(parse('limit=50')).toEqual({ kind: 'newest', limit: 50 });
		expect(parse(`from=${cursor('m3')}`)).toMatchObject({ kind: 'from' });
		expect(parse(`before=${cursor('m3')}`)).toMatchObject({ kind: 'before' });
		expect(parse(`before=${cursor('m3')}&limit=2`)).toMatchObject({ kind: 'before', limit: 2 });
	});

	it.each([
		'limit=0',
		'limit=-1',
		'limit=1.5',
		'limit=abc',
		'limit=',
		'limit=99999999999999999999',
		'limit=1&limit=2',
		'before=',
		'from=',
		'from=m1',
		'before=hc1.not-json',
		`before=${cursor('m1')}&from=${cursor('m2')}`,
		`from=${cursor('m1')}&limit=5`,
	])('rejects %s', (query) => {
		expect(parseHistoryWindow(url(query))).toBeInstanceOf(InvalidRequestError);
	});
});

describe('applyHistoryWindow', () => {
	it('slices the newest messages and keeps the checkpoint and every settlement', () => {
		const result = apply(5, 'limit=2');
		expect(ids(result)).toEqual(['m3', 'm4']);
		expect(result).toMatchObject({
			offset: '42',
			before: cursor('m3'),
			settlements: [{ submissionId: 'sub_0' }],
		});
	});

	it('reports a null cursor when the window reaches the start', () => {
		expect(apply(2, 'limit=5')).toMatchObject({ before: null });
		expect(apply(0, 'limit=5')).toMatchObject({ messages: [], before: null });
	});

	it('expands the window to every message that can still receive live chunks', () => {
		// m1 is an open response still streaming, older than the newest two.
		const result = apply(5, 'limit=2', ['m1']);
		expect(ids(result)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(result).toMatchObject({ before: cursor('m1') });
		// A live target already inside the window changes nothing.
		expect(ids(apply(5, 'limit=2', ['m4']))).toEqual(['m3', 'm4']);
	});

	it('reads from a cursor through the head', () => {
		const result = apply(5, `from=${cursor('m1')}`);
		expect(ids(result)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(result).toMatchObject({ offset: '42', before: cursor('m1') });
		expect(apply(5, `from=${cursor('m0')}`)).toMatchObject({ before: null });
	});

	it('pages backward without a checkpoint', () => {
		const first = apply(7, `before=${cursor('m5')}&limit=2`);
		expect(first).toEqual({
			v: 1,
			conversationId: 'conv',
			messages: expect.any(Array),
			before: cursor('m3'),
		});
		expect(ids(first)).toEqual(['m3', 'm4']);
		const second = apply(7, `before=${cursor('m3')}&limit=5`);
		expect(ids(second)).toEqual(['m0', 'm1', 'm2']);
		expect(second).toMatchObject({ before: null });
		expect(ids(apply(7, `before=${cursor('m2')}`))).toEqual(['m0', 'm1']);
		expect(apply(7, `before=${cursor('m0')}`)).toMatchObject({ messages: [], before: null });
	});

	it('rejects a cursor naming no current message', () => {
		expect(() => apply(3, `before=${cursor('gone')}`)).toThrow(HistoryCursorNotFoundError);
		expect(() => apply(3, `from=${cursor('gone')}`)).toThrow(HistoryCursorNotFoundError);
	});

	it('rejects a cursor from another stream generation even when the message id repeats', () => {
		expect(() => apply(3, `from=${cursor('m1', 'gen_old')}`)).toThrow(HistoryCursorNotFoundError);
		expect(() => apply(3, `before=${cursor('m1', 'gen_old')}`)).toThrow(HistoryCursorNotFoundError);
	});
});

describe('applyResetWindow', () => {
	const reset = (query: string, count = 6, live: string[] = []) =>
		applyResetWindow(snapshot(count), parseResetWindow(url(query)) as ResetWindow, context(live));

	it('passes a reset through whole without bounds', () => {
		const result = reset('');
		expect(ids(result)).toHaveLength(6);
		expect(result).not.toHaveProperty('before');
	});

	it('keeps the anchored window', () => {
		const result = reset(`from=${cursor('m2')}&limit=2`);
		expect(ids(result)).toEqual(['m2', 'm3', 'm4', 'm5']);
		expect(result).toMatchObject({ before: cursor('m2') });
	});

	it('falls back to the newest closed window when the anchor does not resolve', () => {
		expect(ids(reset(`from=${cursor('gone')}&limit=2`))).toEqual(['m4', 'm5']);
		expect(ids(reset(`from=${cursor('m2', 'gen_old')}&limit=2`))).toEqual(['m4', 'm5']);
		expect(ids(reset(`from=${cursor('gone')}&limit=2`, 6, ['m3']))).toEqual(['m3', 'm4', 'm5']);
	});

	it('rejects before on the updates view', () => {
		expect(parseResetWindow(url(`before=${cursor('m1')}`))).toBeInstanceOf(InvalidRequestError);
	});
});
