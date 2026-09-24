import { describe, expect, it } from 'vitest';
import type { AgentConversationSnapshot } from '../conversation-public.ts';
import { HistoryCursorNotFoundError, InvalidRequestError } from '../errors.ts';
import { applyHistoryWindow, parseHistoryWindow } from './conversation-history-window.ts';

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

const ids = (value: { messages: { id: string }[] }) => value.messages.map((message) => message.id);
const parse = (query: string) => parseHistoryWindow(new URL(`https://flue.test/c?${query}`));

describe('parseHistoryWindow', () => {
	it('reads no bounds as the full conversation', () => {
		expect(parse('view=history')).toEqual({ kind: 'full' });
	});

	it('parses limit, before, and from', () => {
		expect(parse('limit=50')).toEqual({ kind: 'newest', limit: 50 });
		expect(parse('from=m3')).toEqual({ kind: 'from', cursor: 'm3' });
		expect(parse('before=m3')).toEqual({ kind: 'before', cursor: 'm3' });
		expect(parse('before=m3&limit=2')).toEqual({ kind: 'before', cursor: 'm3', limit: 2 });
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
		'before=m1&from=m2',
		'from=m1&limit=5',
	])('rejects %s', (query) => {
		expect(parse(query)).toBeInstanceOf(InvalidRequestError);
	});
});

describe('applyHistoryWindow', () => {
	it('returns the unbounded snapshot untouched, without a before cursor', () => {
		const full = snapshot(3);
		const result = applyHistoryWindow(full, { kind: 'full' });
		expect(result).toBe(full);
		expect('before' in result).toBe(false);
	});

	it('slices the newest messages and keeps the checkpoint and every settlement', () => {
		const result = applyHistoryWindow(snapshot(5), { kind: 'newest', limit: 2 });
		expect(ids(result)).toEqual(['m3', 'm4']);
		expect(result).toMatchObject({
			offset: '42',
			before: 'm3',
			settlements: [{ submissionId: 'sub_0' }],
		});
	});

	it('reports a null cursor when the window reaches the start', () => {
		expect(applyHistoryWindow(snapshot(2), { kind: 'newest', limit: 5 })).toMatchObject({
			before: null,
		});
		expect(applyHistoryWindow(snapshot(0), { kind: 'newest', limit: 5 })).toMatchObject({
			messages: [],
			before: null,
		});
	});

	it('reads from a cursor through the head', () => {
		const result = applyHistoryWindow(snapshot(5), { kind: 'from', cursor: 'm1' });
		expect(ids(result)).toEqual(['m1', 'm2', 'm3', 'm4']);
		expect(result).toMatchObject({ offset: '42', before: 'm1' });
		expect(applyHistoryWindow(snapshot(5), { kind: 'from', cursor: 'm0' })).toMatchObject({
			before: null,
		});
	});

	it('pages backward without a checkpoint', () => {
		const first = applyHistoryWindow(snapshot(7), { kind: 'before', cursor: 'm5', limit: 2 });
		expect(first).toEqual({
			v: 1,
			conversationId: 'conv',
			messages: expect.any(Array),
			before: 'm3',
		});
		expect(ids(first)).toEqual(['m3', 'm4']);
		const second = applyHistoryWindow(snapshot(7), { kind: 'before', cursor: 'm3', limit: 5 });
		expect(ids(second)).toEqual(['m0', 'm1', 'm2']);
		expect(second).toMatchObject({ before: null });
		const rest = applyHistoryWindow(snapshot(7), { kind: 'before', cursor: 'm2' });
		expect(ids(rest)).toEqual(['m0', 'm1']);
		const none = applyHistoryWindow(snapshot(7), { kind: 'before', cursor: 'm0' });
		expect(none).toMatchObject({ messages: [], before: null });
	});

	it('rejects a cursor that names no current message', () => {
		expect(() => applyHistoryWindow(snapshot(3), { kind: 'before', cursor: 'gone' })).toThrow(
			HistoryCursorNotFoundError,
		);
		expect(() => applyHistoryWindow(snapshot(3), { kind: 'from', cursor: 'gone' })).toThrow(
			HistoryCursorNotFoundError,
		);
	});
});
