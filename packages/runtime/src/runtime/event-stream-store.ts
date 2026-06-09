/**
 * Durable event stream store with DS-compatible offsets.
 *
 * Stores append-only JSON event streams backed by SQLite. Each stream is
 * identified by a path (e.g. `agents/my-agent/instance-1` or `runs/wf_abc123`).
 * Events get monotonically increasing integer offsets formatted as zero-padded
 * 16-character strings for DS protocol compatibility.
 */

import type { SqlStorage } from '../sql-storage.ts';

const OFFSET_PAD_LENGTH = 16;

/** Format an integer offset as a zero-padded string for DS protocol compatibility. */
export function formatOffset(offset: number): string {
	return String(offset).padStart(OFFSET_PAD_LENGTH, '0');
}

/** Parse a DS offset string back to an integer. Returns -1 for the sentinel "-1". */
export function parseOffset(offset: string): number {
	if (offset === '-1') return -1;
	const n = parseInt(offset, 10);
	if (!Number.isFinite(n) || n < 0) {
		throw new Error(`[flue] Invalid stream offset: "${offset}".`);
	}
	return n;
}

export interface EventStreamReadResult {
	events: Array<{ data: unknown; offset: string }>;
	nextOffset: string;
	upToDate: boolean;
	closed: boolean;
}

export interface EventStreamMeta {
	nextOffset: string;
	closed: boolean;
}

export interface EventStreamStore {
	/** Create a stream. Idempotent — no-op if the stream already exists. */
	createStream(path: string): void;

	/** Append a JSON event. Returns the new offset as a zero-padded string. */
	appendEvent(path: string, event: unknown): string;

	/** Read events starting after the given offset. */
	readEvents(
		path: string,
		opts?: {
			/** "-1" = start, "now" = tail, or an opaque offset. */
			offset?: string;
			/** Server-defined chunk size cap. */
			limit?: number;
		},
	): EventStreamReadResult;

	/** Close a stream. No further appends permitted. Idempotent. */
	closeStream(path: string): void;

	/** Get stream metadata without reading events. Returns null if the stream does not exist. */
	getStreamMeta(path: string): EventStreamMeta | null;

	/** Register a listener for new events on a stream path. Returns unsubscribe. */
	subscribe(path: string, listener: () => void): () => void;

	/** Delete a stream and all its events. */
	deleteStream(path: string): void;
}

// ─── SQL tables ─────────────────────────────────────────────────────────────

const CREATE_STREAMS_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_streams (
  path         TEXT PRIMARY KEY,
  next_offset  INTEGER NOT NULL DEFAULT 1,
  closed       INTEGER NOT NULL DEFAULT 0,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
)`;

const CREATE_ENTRIES_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_stream_entries (
  path    TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (path, seq)
)`;

export function ensureEventStreamTables(sql: SqlStorage): void {
	sql.exec(CREATE_STREAMS_TABLE);
	sql.exec(CREATE_ENTRIES_TABLE);
}

// ─── SQL implementation ─────────────────────────────────────────────────────

const DEFAULT_READ_LIMIT = 100;

export class SqlEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();

	constructor(private sql: SqlStorage) {}

	createStream(path: string): void {
		this.sql.exec(
			`INSERT OR IGNORE INTO flue_event_streams (path) VALUES (?)`,
			path,
		);
	}

	appendEvent(path: string, event: unknown): string {
		// Serialize before any mutation so a JSON.stringify failure cannot
		// leave the offset counter advanced without a stored event.
		const data = JSON.stringify(event);

		// Atomic increment-and-insert via CTE: the UPDATE advances the
		// write cursor and the INSERT stores the event at the old cursor
		// position, all in a single SQL statement. A crash between the
		// two would be impossible because SQLite executes a single
		// statement atomically.
		const rows = this.sql
			.exec(
				`WITH upd AS (
				   UPDATE flue_event_streams
				   SET next_offset = next_offset + 1
				   WHERE path = ? AND closed = 0
				   RETURNING next_offset
				 )
				 INSERT INTO flue_event_stream_entries (path, seq, data)
				 SELECT ?, upd.next_offset - 1, ?
				 FROM upd
				 RETURNING seq`,
				path,
				path,
				data,
			)
			.toArray();

		if (rows.length === 0) {
			// Either the stream doesn't exist or it's closed.
			const meta = this.getStreamMeta(path);
			if (!meta) {
				throw new Error(`[flue] Event stream "${path}" does not exist.`);
			}
			throw new Error(`[flue] Event stream "${path}" is closed.`);
		}

		const offset = rows[0]!.seq as number;

		// Notify live subscribers.
		const bucket = this.listeners.get(path);
		if (bucket) {
			for (const listener of [...bucket]) {
				try {
					listener();
				} catch {
					// Listener errors are silently dropped.
				}
			}
		}

		return formatOffset(offset);
	}

	readEvents(
		path: string,
		opts?: { offset?: string; limit?: number },
	): EventStreamReadResult {
		const meta = this.getStreamMeta(path);
		if (!meta) {
			return { events: [], nextOffset: formatOffset(0), upToDate: true, closed: false };
		}

		const rawOffset = opts?.offset ?? '-1';
		const limit = Math.min(opts?.limit ?? DEFAULT_READ_LIMIT, 1000);

		let startAfter: number;
		if (rawOffset === '-1') {
			startAfter = -1;
		} else if (rawOffset === 'now') {
			return {
				events: [],
				nextOffset: meta.nextOffset,
				upToDate: true,
				closed: meta.closed,
			};
		} else {
			startAfter = parseOffset(rawOffset);
		}

		const rows = this.sql
			.exec(
				`SELECT seq, data FROM flue_event_stream_entries
				 WHERE path = ? AND seq > ?
				 ORDER BY seq ASC
				 LIMIT ?`,
				path,
				startAfter,
				limit,
			)
			.toArray();

		const events = rows.map((row) => ({
			data: JSON.parse(row.data as string) as unknown,
			offset: formatOffset(row.seq as number),
		}));

		// DS protocol: Stream-Next-Offset is the offset of the last returned
		// event (or the stream's tail when no events are returned). The client
		// passes it back as ?offset= and the server returns everything AFTER it
		// via `seq > offset`.
		const lastSeq = events.length > 0 ? (rows[rows.length - 1]!.seq as number) : -1;
		// Up-to-date when we returned fewer events than the limit (no more data
		// available). When no events are returned, we're trivially up to date.
		const upToDate = events.length < limit;

		// When events were returned, nextOffset is the last event's offset.
		// When no events were returned, echo the requested offset so the
		// client re-polls from the same position. Event offsets start at 1,
		// so formatOffset(0) is the "before first event" sentinel.
		const nextOffset = events.length > 0
			? formatOffset(lastSeq)
			: formatOffset(Math.max(0, startAfter));

		return {
			events,
			nextOffset,
			upToDate,
			closed: meta.closed,
		};
	}

	closeStream(path: string): void {
		this.sql.exec(
			`UPDATE flue_event_streams SET closed = 1 WHERE path = ?`,
			path,
		);
		// Notify live subscribers so long-poll/SSE readers wake immediately
		// on stream closure (DS protocol Section 5.7 MUST requirement).
		const bucket = this.listeners.get(path);
		if (bucket) {
			for (const listener of [...bucket]) {
				try {
					listener();
				} catch {
					// Listener errors are silently dropped.
				}
			}
		}
	}

	getStreamMeta(path: string): EventStreamMeta | null {
		const rows = this.sql
			.exec(
				`SELECT next_offset, closed FROM flue_event_streams WHERE path = ?`,
				path,
			)
			.toArray();

		if (rows.length === 0) return null;
		const row = rows[0]!;
		const writeHead = row.next_offset as number;
		// Tail offset is the last appended event's offset. Event offsets
		// start at 1 so writeHead - 1 gives the last event, and 0 is the
		// "before first event" sentinel for empty streams.
		return {
			nextOffset: formatOffset(Math.max(0, writeHead - 1)),
			closed: (row.closed as number) === 1,
		};
	}

	subscribe(path: string, listener: () => void): () => void {
		let bucket = this.listeners.get(path);
		if (!bucket) {
			bucket = new Set();
			this.listeners.set(path, bucket);
		}
		bucket.add(listener);
		return () => {
			bucket!.delete(listener);
			if (bucket!.size === 0) {
				this.listeners.delete(path);
			}
		};
	}

	deleteStream(path: string): void {
		this.sql.exec(`DELETE FROM flue_event_stream_entries WHERE path = ?`, path);
		this.sql.exec(`DELETE FROM flue_event_streams WHERE path = ?`, path);
		this.listeners.delete(path);
	}
}
