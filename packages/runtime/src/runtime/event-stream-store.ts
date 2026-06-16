/**
 * Durable event stream store — async interface and SQLite implementation.
 *
 * Stores append-only JSON event streams. Each stream is identified by a path
 * (e.g. `agents/my-agent/instance-1` or `runs/run_01JX...`). Events get
 * monotonically increasing integer offsets formatted as `<readSeq>_<seq>` —
 * two 16-digit zero-padded integers separated by an underscore, matching the
 * DS reference server's offset format. The first component is always `0`
 * (Flue has no file segments); the second is the sequence number.
 *
 * The interface is fully async (returns Promises) so that adapters backed by
 * async databases (Postgres, MongoDB, etc.) can implement it naturally. The
 * only exception is {@link EventStreamStore.subscribe}, which is an in-memory
 * listener registration and stays synchronous.
 */

import { clampLimit } from '../adapter-helpers.ts';
import { ensureFlueSchemaVersion } from '../schema-version.ts';
import type { SqlStorage } from '../sql-storage.ts';

// ─── Offset utilities ───────────────────────────────────────────────────────

const COMPONENT_PAD = 16;
const ZERO_COMPONENT = '0'.repeat(COMPONENT_PAD);

/**
 * Format an integer sequence number as a DS-compatible offset string.
 *
 * Produces `<readSeq>_<seq>` with both components zero-padded to 16 digits,
 * matching the DS reference server's offset format. The first component is
 * always `0` (Flue uses integer sequences, not segmented files).
 */
export function formatOffset(seq: number): string {
	if (seq === -1) return '-1';
	return `${ZERO_COMPONENT}_${String(seq).padStart(COMPONENT_PAD, '0')}`;
}

/**
 * Parse a DS offset string back to an integer sequence number.
 * Accepts the `<readSeq>_<seq>` format and extracts the second component.
 * Returns -1 for the sentinel `"-1"`. Throws on any other format.
 */
export function parseOffset(offset: string): number {
	if (offset === '-1') return -1;
	const match = /^\d+_(\d+)$/.exec(offset);
	const sequence = match?.[1];
	if (!sequence) {
		throw new Error(`[flue] Invalid stream offset: "${offset}".`);
	}
	return parseInt(sequence, 10);
}

export function agentStreamPath(agentName: string, instanceId: string): string {
	return `agents/${agentName}/${instanceId}`;
}

export function runStreamPath(runId: string): string {
	return `runs/${runId}`;
}

// ─── Interface ──────────────────────────────────────────────────────────────

export interface EventStreamReadResult {
	events: Array<{ data: unknown; offset: string }>;
	/**
	 * Resume cursor: the offset of the last event delivered in this read, or
	 * the caller's effective start offset when no events were returned. Pass
	 * it back as `offset` to continue reading strictly after it. This is NOT
	 * the next sequence number to be assigned — the name follows the Durable
	 * Streams `Stream-Next-Offset` wire field, "the offset to use for the
	 * next read".
	 */
	nextOffset: string;
	upToDate: boolean;
	closed: boolean;
}

export interface EventStreamMeta {
	/**
	 * Resume cursor: the offset of the last appended event, or `"-1"` when
	 * the stream is empty. Pass it back as `offset` to read strictly after
	 * it. This is NOT the next sequence number to be assigned.
	 */
	nextOffset: string;
	closed: boolean;
}

export interface EventStreamStore {
	/** Create a stream. Idempotent — no-op if the stream already exists. */
	createStream(path: string): Promise<void>;

	/** Append a JSON event. Returns the new offset as a zero-padded string. */
	appendEvent(path: string, event: unknown): Promise<string>;

	/** Read events starting after the given offset. */
	readEvents(
		path: string,
		opts?: {
			/** "-1" = start, "now" = tail, or an opaque offset. */
			offset?: string;
			/** Server-defined chunk size cap. */
			limit?: number;
		},
	): Promise<EventStreamReadResult>;

	/** Close a stream. No further appends permitted. Idempotent. */
	closeStream(path: string): Promise<void>;

	/** Get stream metadata without reading events. Returns null if the stream does not exist. */
	getStreamMeta(path: string): Promise<EventStreamMeta | null>;

	/**
	 * Register a listener for new events on a stream path. Returns unsubscribe.
	 *
	 * This is always synchronous — it registers an in-memory callback. Listeners
	 * fire for appends made through this store instance; cross-process delivery
	 * is adapter-dependent and not part of the current contract.
	 */
	subscribe(path: string, listener: () => void): () => void;
}

// ─── SQLite implementation ──────────────────────────────────────────────────

const CREATE_STREAMS_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_streams (
  path         TEXT PRIMARY KEY,
  next_offset  INTEGER NOT NULL DEFAULT 0,
  closed       INTEGER NOT NULL DEFAULT 0
)`;

const CREATE_ENTRIES_TABLE = `
CREATE TABLE IF NOT EXISTS flue_event_stream_entries (
  path    TEXT NOT NULL,
  seq     INTEGER NOT NULL,
  data    TEXT NOT NULL,
  PRIMARY KEY (path, seq)
)`;

export const DEFAULT_READ_LIMIT = 100;
export const MAX_READ_LIMIT = 1000;

/**
 * SQLite-backed {@link EventStreamStore}.
 *
 * Works with both `node:sqlite` (via the {@link SqlStorage} adapter) and
 * Cloudflare DO SQLite. Tables are created in the constructor — no separate
 * migration step required. The constructor stamps a fresh database with the
 * current schema version and throws when the database records an unknown or
 * newer version.
 *
 * All methods are `async` to satisfy the interface contract but resolve
 * synchronously since SQLite operations are synchronous.
 */
export class SqliteEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();

	constructor(private sql: SqlStorage) {
		ensureFlueSchemaVersion(sql);
		sql.exec(CREATE_STREAMS_TABLE);
		sql.exec(CREATE_ENTRIES_TABLE);
	}

	async createStream(path: string): Promise<void> {
		this.sql.exec(`INSERT OR IGNORE INTO flue_event_streams (path) VALUES (?)`, path);
	}

	async appendEvent(path: string, event: unknown): Promise<string> {
		// Serialize before any mutation so a JSON.stringify failure cannot
		// leave the offset counter advanced without a stored event.
		const data = JSON.stringify(event);

		// Two sequential statements: advance the write cursor, then insert
		// the event at the old cursor position. This is safe for the
		// single-process SQLite configurations Flue currently supports. A
		// process crash between the two leaves a gap in the sequence,
		// which is harmless — readEvents uses `seq > ?` and naturally
		// skips missing numbers. Shared SQLite files across Node processes
		// need a transactional append implementation before being supported.
		const updated = this.sql
			.exec(
				`UPDATE flue_event_streams
				 SET next_offset = next_offset + 1
				 WHERE path = ? AND closed = 0
				 RETURNING next_offset`,
				path,
			)
			.toArray();

		if (updated.length === 0) {
			// Either the stream doesn't exist or it's closed.
			const meta = await this.getStreamMeta(path);
			if (!meta) {
				throw new Error(`[flue] Event stream "${path}" does not exist.`);
			}
			throw new Error(`[flue] Event stream "${path}" is closed.`);
		}

		const [updatedRow] = updated;
		if (!updatedRow) throw new Error(`[flue] Event stream "${path}" could not be updated.`);
		const offset = (updatedRow.next_offset as number) - 1;

		this.sql.exec(
			`INSERT INTO flue_event_stream_entries (path, seq, data) VALUES (?, ?, ?)`,
			path,
			offset,
			data,
		);

		// Notify live subscribers.
		this.notifyListeners(path);

		return formatOffset(offset);
	}

	async readEvents(
		path: string,
		opts?: { offset?: string; limit?: number },
	): Promise<EventStreamReadResult> {
		const meta = await this.getStreamMeta(path);
		if (!meta) {
			return { events: [], nextOffset: formatOffset(-1), upToDate: true, closed: false };
		}

		const rawOffset = opts?.offset ?? '-1';
		const limit = clampLimit(opts?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);

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
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit);

		const events = page.map((row) => ({
			data: JSON.parse(row.data as string) as unknown,
			offset: formatOffset(row.seq as number),
		}));

		const lastRow = page.at(-1);
		const lastSeq = lastRow ? (lastRow.seq as number) : -1;
		const upToDate = rows.length <= limit;

		const nextOffset = events.length > 0 ? formatOffset(lastSeq) : formatOffset(startAfter);

		return {
			events,
			nextOffset,
			upToDate,
			closed: meta.closed,
		};
	}

	async closeStream(path: string): Promise<void> {
		this.sql.exec(`UPDATE flue_event_streams SET closed = 1 WHERE path = ?`, path);
		// Notify live subscribers so long-poll/SSE readers wake immediately
		// on stream closure (DS protocol Section 5.7 MUST requirement).
		this.notifyListeners(path);
	}

	async getStreamMeta(path: string): Promise<EventStreamMeta | null> {
		const rows = this.sql
			.exec(`SELECT next_offset, closed FROM flue_event_streams WHERE path = ?`, path)
			.toArray();

		const [row] = rows;
		if (!row) return null;
		const writeHead = row.next_offset as number;
		return {
			nextOffset: formatOffset(writeHead - 1),
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
		const subscribedBucket = bucket;
		return () => {
			subscribedBucket.delete(listener);
			if (subscribedBucket.size === 0) {
				this.listeners.delete(path);
			}
		};
	}

	// ─── Private ────────────────────────────────────────────────────────

	private notifyListeners(path: string): void {
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
}
