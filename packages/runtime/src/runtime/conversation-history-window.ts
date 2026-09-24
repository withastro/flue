import type { ConversationUiMessage } from '../conversation-projections.ts';
import type { AgentConversationSnapshot } from '../conversation-public.ts';
import { HistoryCursorNotFoundError, InvalidRequestError } from '../errors.ts';

/**
 * Bounded history reads (`?view=history` with `limit` / `before` / `from`).
 *
 * The active conversation path is append-only and a materialized message's id
 * is stable for the life of the conversation (an assistant response keeps its
 * first step's id), so a message id is a sound positional cursor. Stream
 * offsets are not: they index canonical records, and one rendered message
 * spans many records. Cursors are documented to clients as opaque strings; the
 * first-party SDK relies on them being message ids to anchor re-hydration.
 *
 * - `limit=N` — the newest N messages, as a full snapshot (offset, incarnation,
 *   settlements) that can seed `observe()`.
 * - `from=<cursor>` — every message from the cursor's message (inclusive)
 *   through the head, as a full snapshot. `observe()` re-hydrates with it so a
 *   reconnect never leaves a gap below the window it already holds.
 * - `before=<cursor>[&limit=N]` — an older page: messages strictly before the
 *   cursor (the newest N of them when limited). Carries no offset or
 *   incarnation, so it cannot seed an observation.
 *
 * Bounded snapshots and pages carry `before`: the cursor for the next older
 * page (the id of the oldest returned message), or `null` when the response
 * reaches the start of the conversation. Unbounded reads omit it, so their
 * wire shape is unchanged. Settlements always ship whole on snapshots: clients
 * derive "still active" from message submission ids minus settled ids, which
 * is only sound when settlements cover every submission in the window.
 */
export type HistoryWindow =
	| { kind: 'full' }
	| { kind: 'newest'; limit: number }
	| { kind: 'from'; cursor: string }
	| { kind: 'before'; cursor: string; limit?: number };

/** An older history page (`before=<cursor>`). */
export interface AgentConversationHistoryPage {
	v: 1;
	conversationId: string;
	messages: ConversationUiMessage[];
	before: string | null;
}

export function parseHistoryWindow(url: URL): HistoryWindow | InvalidRequestError {
	const params = url.searchParams;
	for (const name of ['limit', 'before', 'from']) {
		if (params.getAll(name).length > 1) {
			return new InvalidRequestError({ reason: `History reads accept at most one "${name}".` });
		}
	}
	const rawLimit = params.get('limit');
	const before = params.get('before');
	const from = params.get('from');
	let limit: number | undefined;
	if (rawLimit !== null) {
		limit = /^[1-9][0-9]*$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
		if (!Number.isSafeInteger(limit)) {
			return new InvalidRequestError({
				reason: 'History "limit" must be a positive integer.',
			});
		}
	}
	if (before === '' || from === '') {
		return new InvalidRequestError({ reason: 'History cursors must be non-empty.' });
	}
	if (before !== null && from !== null) {
		return new InvalidRequestError({
			reason: 'History reads accept "before" or "from", not both.',
		});
	}
	if (from !== null) {
		if (limit !== undefined) {
			return new InvalidRequestError({
				reason:
					'History "from" reads return everything through the head and do not accept "limit".',
			});
		}
		return { kind: 'from', cursor: from };
	}
	if (before !== null) {
		return limit === undefined
			? { kind: 'before', cursor: before }
			: { kind: 'before', cursor: before, limit };
	}
	if (limit !== undefined) return { kind: 'newest', limit };
	return { kind: 'full' };
}

/**
 * Apply a history window to a fully projected snapshot. Throws
 * {@link HistoryCursorNotFoundError} when a cursor names no current message.
 */
export function applyHistoryWindow(
	snapshot: AgentConversationSnapshot,
	window: HistoryWindow,
): AgentConversationSnapshot | AgentConversationHistoryPage {
	const messages = snapshot.messages;
	switch (window.kind) {
		case 'full':
			return snapshot;
		case 'newest': {
			const start = Math.max(0, messages.length - window.limit);
			return { ...snapshot, messages: messages.slice(start), before: cursorAt(messages, start) };
		}
		case 'from': {
			const start = indexOfCursor(messages, window.cursor);
			return { ...snapshot, messages: messages.slice(start), before: cursorAt(messages, start) };
		}
		case 'before': {
			const end = indexOfCursor(messages, window.cursor);
			const start = window.limit === undefined ? 0 : Math.max(0, end - window.limit);
			return {
				v: 1,
				conversationId: snapshot.conversationId,
				messages: messages.slice(start, end),
				before: cursorAt(messages, start),
			};
		}
	}
}

function indexOfCursor(messages: readonly ConversationUiMessage[], cursor: string): number {
	const index = messages.findIndex((message) => message.id === cursor);
	if (index < 0) throw new HistoryCursorNotFoundError({ cursor });
	return index;
}

/** Cursor for the page older than `messages[start..]`: its first id, or null at the origin. */
function cursorAt(messages: readonly ConversationUiMessage[], start: number): string | null {
	return start > 0 ? (messages[start]?.id ?? null) : null;
}
