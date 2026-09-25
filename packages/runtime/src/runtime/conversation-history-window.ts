import type { ConversationUiMessage } from '../conversation-projections.ts';
import type { AgentConversationSnapshot } from '../conversation-public.ts';
import { HistoryCursorNotFoundError, InvalidRequestError } from '../errors.ts';

/**
 * Bounded history reads (`?view=history` with `limit` / `before` / `from`) and
 * bounded `conversation-reset` snapshots on `?view=updates`.
 *
 * Position. The active conversation path is append-only and a materialized
 * message's id is stable for the life of a stream generation (an assistant
 * response keeps its first step's id), so a message is a sound positional
 * boundary. Stream offsets are not: they index canonical records, and one
 * rendered message spans many records.
 *
 * Generation. Message ids are not unique across generations — caller-keyed
 * submissions derive deterministic ids, and a reset-and-regrown stream can
 * reuse them — so a cursor binds the message to the stream incarnation it was
 * issued in. A cursor from another generation is gone (410), never silently
 * resolved against different content. The wire cursor is an opaque, versioned
 * token; clients must not interpret it.
 *
 * Closure. A window never cuts out a message that can still receive live
 * chunks (see `projectLiveMessageTargets`): the start expands backward to the
 * oldest such message, so a window may hold more than `limit` messages. The
 * expanded start is the window's boundary for paging and re-hydration.
 *
 * - `limit=N` — the newest N messages (closed), as a full snapshot (offset,
 *   incarnation, settlements) that can seed `observe()`.
 * - `from=<cursor>` — every message from the cursor's message (inclusive,
 *   closed) through the head, as a full snapshot. `observe()` re-hydrates with
 *   it so a reconnect never leaves a gap below the window it already holds.
 * - `before=<cursor>[&limit=N]` — an older page: messages strictly before the
 *   cursor (the newest N of them when limited). Carries no offset or
 *   incarnation, so it cannot seed an observation.
 *
 * Bounded snapshots and pages carry `before`: the cursor for the next older
 * page (naming the oldest returned message), or `null` when the response
 * reaches the start of the conversation. Unbounded reads omit it, so their
 * wire shape is unchanged. Settlements always ship whole on snapshots: clients
 * derive "still active" from message submission ids minus settled ids, which
 * is only sound when settlements cover every submission in the window.
 */
export type HistoryWindow =
	| { kind: 'full' }
	| { kind: 'newest'; limit: number }
	| { kind: 'from'; cursor: HistoryCursor }
	| { kind: 'before'; cursor: HistoryCursor; limit?: number };

/**
 * Window applied to `conversation-reset` snapshots on the updates view. A
 * bounded observation sends its anchor (`from`) and page size (`limit`):
 * resets keep the anchored window when the anchor still resolves in this
 * generation, and fall back to the newest closed `limit` messages otherwise
 * (the client sees a changed cursor and re-bases).
 */
export interface ResetWindow {
	from?: HistoryCursor;
	limit?: number;
}

/** A decoded history cursor: one message in one stream generation. */
interface HistoryCursor {
	/** The raw token, echoed in errors. */
	token: string;
	incarnation: string;
	messageId: string;
}

/** Context a window resolves against: the serving generation and live targets. */
export interface HistoryWindowContext {
	incarnation: string;
	liveTargets: ReadonlySet<string>;
}

/** An older history page (`before=<cursor>`). */
export interface AgentConversationHistoryPage {
	v: 1;
	conversationId: string;
	messages: ConversationUiMessage[];
	before: string | null;
}

const CURSOR_PREFIX = 'hc1.';

export function encodeHistoryCursor(incarnation: string, messageId: string): string {
	const bytes = new TextEncoder().encode(JSON.stringify([incarnation, messageId]));
	let binary = '';
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return CURSOR_PREFIX + btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeHistoryCursor(token: string): HistoryCursor | undefined {
	if (!token.startsWith(CURSOR_PREFIX)) return undefined;
	const body = token.slice(CURSOR_PREFIX.length);
	if (!/^[A-Za-z0-9_-]+$/.test(body)) return undefined;
	try {
		const binary = atob(body.replace(/-/g, '+').replace(/_/g, '/'));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const value: unknown = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
		);
		if (
			!Array.isArray(value) ||
			value.length !== 2 ||
			typeof value[0] !== 'string' ||
			typeof value[1] !== 'string' ||
			value[1] === ''
		) {
			return undefined;
		}
		return { token, incarnation: value[0], messageId: value[1] };
	} catch {
		return undefined;
	}
}

type BoundParams = { limit?: number; before?: HistoryCursor; from?: HistoryCursor };

function parseBoundParams(url: URL): BoundParams | InvalidRequestError {
	const params = url.searchParams;
	for (const name of ['limit', 'before', 'from']) {
		if (params.getAll(name).length > 1) {
			return new InvalidRequestError({ reason: `History reads accept at most one "${name}".` });
		}
	}
	const bounds: BoundParams = {};
	const rawLimit = params.get('limit');
	if (rawLimit !== null) {
		const limit = /^[1-9][0-9]*$/.test(rawLimit) ? Number(rawLimit) : Number.NaN;
		if (!Number.isSafeInteger(limit)) {
			return new InvalidRequestError({ reason: 'History "limit" must be a positive integer.' });
		}
		bounds.limit = limit;
	}
	for (const name of ['before', 'from'] as const) {
		const raw = params.get(name);
		if (raw === null) continue;
		const cursor = decodeHistoryCursor(raw);
		if (!cursor) {
			return new InvalidRequestError({
				reason: `History "${name}" must be a cursor returned by a previous history read.`,
			});
		}
		bounds[name] = cursor;
	}
	return bounds;
}

export function parseHistoryWindow(url: URL): HistoryWindow | InvalidRequestError {
	const bounds = parseBoundParams(url);
	if (bounds instanceof InvalidRequestError) return bounds;
	const { limit, before, from } = bounds;
	if (before && from) {
		return new InvalidRequestError({
			reason: 'History reads accept "before" or "from", not both.',
		});
	}
	if (from) {
		if (limit !== undefined) {
			return new InvalidRequestError({
				reason:
					'History "from" reads return everything through the head and do not accept "limit".',
			});
		}
		return { kind: 'from', cursor: from };
	}
	if (before) {
		return limit === undefined
			? { kind: 'before', cursor: before }
			: { kind: 'before', cursor: before, limit };
	}
	if (limit !== undefined) return { kind: 'newest', limit };
	return { kind: 'full' };
}

/** Parse the reset window of an updates read (`from` and/or `limit`). */
export function parseResetWindow(url: URL): ResetWindow | InvalidRequestError {
	const bounds = parseBoundParams(url);
	if (bounds instanceof InvalidRequestError) return bounds;
	if (bounds.before) {
		return new InvalidRequestError({ reason: 'Update streams do not accept "before".' });
	}
	return {
		...(bounds.from ? { from: bounds.from } : {}),
		...(bounds.limit !== undefined ? { limit: bounds.limit } : {}),
	};
}

/**
 * Apply a history window to a fully projected snapshot. Throws
 * {@link HistoryCursorNotFoundError} when a cursor belongs to another stream
 * generation or names no current message.
 */
export function applyHistoryWindow(
	snapshot: AgentConversationSnapshot,
	window: HistoryWindow,
	context: HistoryWindowContext,
): AgentConversationSnapshot | AgentConversationHistoryPage {
	const messages = snapshot.messages;
	switch (window.kind) {
		case 'full':
			return snapshot;
		case 'newest':
			return windowFrom(snapshot, Math.max(0, messages.length - window.limit), context);
		case 'from':
			return windowFrom(snapshot, resolveCursor(messages, window.cursor, context), context);
		case 'before': {
			const end = resolveCursor(messages, window.cursor, context);
			const start = window.limit === undefined ? 0 : Math.max(0, end - window.limit);
			return {
				v: 1,
				conversationId: snapshot.conversationId,
				messages: messages.slice(start, end),
				before: cursorAt(messages, start, context.incarnation),
			};
		}
	}
}

/**
 * Apply a reset window to a `conversation-reset` snapshot. Never throws: an
 * anchor that no longer resolves falls back to the newest `limit` messages,
 * and with neither bound the snapshot passes through whole.
 */
export function applyResetWindow(
	snapshot: AgentConversationSnapshot,
	window: ResetWindow,
	context: HistoryWindowContext,
): AgentConversationSnapshot {
	const messages = snapshot.messages;
	if (window.from && window.from.incarnation === context.incarnation) {
		const anchor = window.from.messageId;
		const index = messages.findIndex((message) => message.id === anchor);
		if (index >= 0) return windowFrom(snapshot, index, context);
	}
	if (window.limit !== undefined) {
		return windowFrom(snapshot, Math.max(0, messages.length - window.limit), context);
	}
	return snapshot;
}

/** The closed window starting no later than `start`. */
function windowFrom(
	snapshot: AgentConversationSnapshot,
	start: number,
	context: HistoryWindowContext,
): AgentConversationSnapshot {
	const messages = snapshot.messages;
	let closed = start;
	for (let index = 0; index < start; index++) {
		if (context.liveTargets.has((messages[index] as ConversationUiMessage).id)) {
			closed = index;
			break;
		}
	}
	return {
		...snapshot,
		messages: messages.slice(closed),
		before: cursorAt(messages, closed, context.incarnation),
	};
}

function resolveCursor(
	messages: readonly ConversationUiMessage[],
	cursor: HistoryCursor,
	context: HistoryWindowContext,
): number {
	const index =
		cursor.incarnation === context.incarnation
			? messages.findIndex((message) => message.id === cursor.messageId)
			: -1;
	if (index < 0) throw new HistoryCursorNotFoundError({ cursor: cursor.token });
	return index;
}

/** Cursor for the page older than `messages[start..]`, or null at the origin. */
function cursorAt(
	messages: readonly ConversationUiMessage[],
	start: number,
	incarnation: string,
): string | null {
	const message = start > 0 ? messages[start] : undefined;
	return message ? encodeHistoryCursor(incarnation, message.id) : null;
}
