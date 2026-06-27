import { clampLimit } from '../adapter-helpers.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import { ConversationStreamStoreError } from '../errors.ts';
import { migrateFlueSqlSchema } from '../schema-version.ts';
import { parseSessionStorageKey } from '../session-identity.ts';
import type { SqlStorage } from '../sql-storage.ts';
import { formatOffset, parseOffset } from './event-stream-store.ts';

export interface ConversationStreamIdentity {
	agentName: string;
	instanceId: string;
}

export interface ConversationProducerClaim {
	producerId: string;
	producerEpoch: number;
	incarnation: string;
	nextProducerSequence: number;
	offset: string;
}

export interface ConversationStreamBatch {
	offset: string;
	records: ConversationRecord[];
}

export interface ConversationStreamReadResult {
	batches: ConversationStreamBatch[];
	nextOffset: string;
	upToDate: boolean;
	closed: boolean;
}

export interface ConversationStreamMeta {
	identity: ConversationStreamIdentity;
	incarnation: string;
	nextOffset: string;
	closed: boolean;
	producerId: string | null;
	producerEpoch: number;
	nextProducerSequence: number;
}

export interface ConversationStreamStore {
	createStream(path: string, identity: ConversationStreamIdentity): Promise<void>;
	acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim>;
	append(input: {
		path: string;
		producerId: string;
		producerEpoch: number;
		incarnation: string;
		producerSequence: number;
		expectedOffset?: string;
		submission?: { submissionId: string; attemptId: string };
		records: readonly ConversationRecord[];
	}): Promise<{ offset: string }>;
	read(
		path: string,
		options?: { offset?: string; limit?: number },
	): Promise<ConversationStreamReadResult>;
	getMeta(path: string): Promise<ConversationStreamMeta | null>;
	close(path: string): Promise<void>;
	delete(path: string): Promise<void>;
	subscribe(path: string, listener: () => void): () => void;
}

const CREATE_STREAMS_TABLE = `
CREATE TABLE IF NOT EXISTS flue_conversation_streams (
  path TEXT PRIMARY KEY,
  identity_json TEXT NOT NULL,
  next_offset INTEGER NOT NULL DEFAULT 0,
  closed INTEGER NOT NULL DEFAULT 0,
  producer_id TEXT,
  producer_epoch INTEGER NOT NULL DEFAULT 0,
  next_producer_sequence INTEGER NOT NULL DEFAULT 0,
  incarnation TEXT NOT NULL
)`;

const CREATE_BATCHES_TABLE = `
CREATE TABLE IF NOT EXISTS flue_conversation_stream_batches (
  path TEXT NOT NULL,
  seq INTEGER NOT NULL,
  producer_id TEXT NOT NULL,
  producer_epoch INTEGER NOT NULL,
  producer_sequence INTEGER NOT NULL,
  data TEXT NOT NULL,
  submission_id TEXT,
  attempt_id TEXT,
  PRIMARY KEY (path, seq),
  UNIQUE (path, producer_id, producer_epoch, producer_sequence)
)`;

const DEFAULT_READ_LIMIT = 100;
const MAX_READ_LIMIT = 1000;

export function ensureSqlConversationStreamTables(sql: SqlStorage): void {
	migrateFlueSqlSchema(sql, () => {
		sql.exec(CREATE_STREAMS_TABLE);
		sql.exec(CREATE_BATCHES_TABLE);
	});
}

interface InMemoryConversationBatch extends ConversationStreamBatch {
	producerId: string;
	producerEpoch: number;
	producerSequence: number;
	data: string;
	submissionId: string | null;
	attemptId: string | null;
}

interface InMemoryConversationStream {
	identity: ConversationStreamIdentity;
	incarnation: string;
	closed: boolean;
	producerId: string | null;
	producerEpoch: number;
	nextProducerSequence: number;
	batches: InMemoryConversationBatch[];
}

export class InMemoryConversationStreamStore implements ConversationStreamStore {
	private streams = new Map<string, InMemoryConversationStream>();
	private listeners = new Map<string, Set<() => void>>();

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const existing = this.streams.get(path);
		if (existing) {
			if (
				existing.identity.agentName !== identity.agentName ||
				existing.identity.instanceId !== identity.instanceId
			) {
				this.fail('create', path, 'Stream identity conflicts.');
			}
			return;
		}
		this.streams.set(path, {
			identity: { ...identity },
			incarnation: crypto.randomUUID(),
			closed: false,
			producerId: null,
			producerEpoch: 0,
			nextProducerSequence: 0,
			batches: [],
		});
	}

	async acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim> {
		const stream = this.streams.get(path);
		if (!stream) this.fail('acquire_producer', path, 'Stream does not exist.');
		if (stream.closed) this.fail('acquire_producer', path, 'Stream is closed.');
		stream.producerId = producerId;
		stream.producerEpoch += 1;
		stream.nextProducerSequence = 0;
		return {
			producerId,
			producerEpoch: stream.producerEpoch,
			incarnation: stream.incarnation,
			nextProducerSequence: 0,
			offset: formatOffset(stream.batches.length - 1),
		};
	}

	async append(input: {
		path: string;
		producerId: string;
		producerEpoch: number;
		incarnation: string;
		producerSequence: number;
		expectedOffset?: string;
		submission?: { submissionId: string; attemptId: string };
		records: readonly ConversationRecord[];
	}): Promise<{ offset: string }> {
		if (input.records.length === 0) this.fail('append', input.path, 'A canonical batch cannot be empty.');
		const data = JSON.stringify(input.records);
		const stream = this.streams.get(input.path);
		if (!stream) this.fail('append', input.path, 'Stream does not exist.');
		if (stream.closed) this.fail('append', input.path, 'Stream is closed.');
		if (
			stream.producerId !== input.producerId ||
			stream.producerEpoch !== input.producerEpoch ||
			stream.incarnation !== input.incarnation
		) {
			this.fail('append', input.path, 'Producer ownership is stale.');
		}
		const retry = stream.batches.find(
			(batch) =>
				batch.producerId === input.producerId &&
				batch.producerEpoch === input.producerEpoch &&
				batch.producerSequence === input.producerSequence,
		);
		if (retry) {
			if (
				retry.data !== data ||
				retry.submissionId !== (input.submission?.submissionId ?? null) ||
				retry.attemptId !== (input.submission?.attemptId ?? null)
			) {
				this.fail('append', input.path, 'Producer sequence has conflicting content.');
			}
			return { offset: retry.offset };
		}
		if (stream.nextProducerSequence !== input.producerSequence) {
			this.fail('append', input.path, 'Producer sequence is not the next expected value.');
		}
		const head = formatOffset(stream.batches.length - 1);
		if (input.expectedOffset !== undefined && input.expectedOffset !== head) {
			this.fail('append', input.path, 'Expected stream head does not match the current head.');
		}
		this.assertSubmissionOwnership(input.path, input.submission, input.records);
		const offset = formatOffset(stream.batches.length);
		stream.batches.push({
			offset,
			records: JSON.parse(data) as ConversationRecord[],
			producerId: input.producerId,
			producerEpoch: input.producerEpoch,
			producerSequence: input.producerSequence,
			data,
			submissionId: input.submission?.submissionId ?? null,
			attemptId: input.submission?.attemptId ?? null,
		});
		stream.nextProducerSequence += 1;
		this.notify(input.path);
		return { offset };
	}

	async read(
		path: string,
		options?: { offset?: string; limit?: number },
	): Promise<ConversationStreamReadResult> {
		const stream = this.streams.get(path);
		if (!stream) return { batches: [], nextOffset: '-1', upToDate: true, closed: false };
		const head = stream.batches.length - 1;
		const rawOffset = options?.offset ?? '-1';
		if (rawOffset === 'now') {
			return { batches: [], nextOffset: formatOffset(head), upToDate: true, closed: stream.closed };
		}
		const startAfter = parseOffset(rawOffset);
		if (!Number.isSafeInteger(startAfter) || startAfter > head) {
			this.fail('read', path, 'Read offset is beyond the canonical stream head.');
		}
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const page = stream.batches.slice(startAfter + 1, startAfter + 1 + limit);
		return {
			batches: page.map((batch) => ({
				offset: batch.offset,
				records: JSON.parse(batch.data) as ConversationRecord[],
			})),
			nextOffset: page.at(-1)?.offset ?? formatOffset(startAfter),
			upToDate: startAfter + page.length >= head,
			closed: stream.closed,
		};
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const stream = this.streams.get(path);
		if (!stream) return null;
		return {
			identity: { ...stream.identity },
			incarnation: stream.incarnation,
			nextOffset: formatOffset(stream.batches.length - 1),
			closed: stream.closed,
			producerId: stream.producerId,
			producerEpoch: stream.producerEpoch,
			nextProducerSequence: stream.nextProducerSequence,
		};
	}

	async close(path: string): Promise<void> {
		const stream = this.streams.get(path);
		if (stream) stream.closed = true;
		this.notify(path);
	}

	async delete(path: string): Promise<void> {
		this.streams.delete(path);
		this.notify(path);
	}

	subscribe(path: string, listener: () => void): () => void {
		let listeners = this.listeners.get(path);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(path, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.listeners.delete(path);
		};
	}

	private assertSubmissionOwnership(
		path: string,
		submission: { submissionId: string; attemptId: string } | undefined,
		records: readonly ConversationRecord[],
	): void {
		const owned = records.filter(
			(record) => record.submissionId !== undefined || record.attemptId !== undefined,
		);
		if (!submission) {
			if (owned.length > 0) this.fail('append', path, 'Submission-owned records require an attempt authorization.');
			return;
		}
		if (
			owned.some(
				(record) =>
					record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId,
			)
		) {
			this.fail('append', path, 'Record ownership does not match the authorized submission attempt.');
		}
	}

	private fail(operation: string, path: string, reason: string): never {
		throw new ConversationStreamStoreError({ operation, path, reason });
	}

	private notify(path: string): void {
		for (const listener of this.listeners.get(path) ?? []) {
			try {
				listener();
			} catch {}
		}
	}
}

export class SqliteConversationStreamStore implements ConversationStreamStore {
	private listeners = new Map<string, Set<() => void>>();

	constructor(
		private sql: SqlStorage,
		private runTransaction: <T>(closure: () => T) => T,
	) {
		ensureSqlConversationStreamTables(sql);
	}

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const data = JSON.stringify(identity);
		this.runTransaction(() => {
			const existing = this.sql
				.exec('SELECT identity_json FROM flue_conversation_streams WHERE path = ?', path)
				.toArray()[0];
			if (existing) {
				if (existing.identity_json !== data) this.fail('create', path, 'Stream identity conflicts.');
				return;
			}
			this.sql.exec(
				'INSERT INTO flue_conversation_streams (path, identity_json, incarnation) VALUES (?, ?, ?)',
				path,
				data,
				crypto.randomUUID(),
			);
		});
	}

	async acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim> {
		return this.runTransaction(() => {
			const row = this.sql
				.exec(
					`UPDATE flue_conversation_streams
					 SET producer_id = ?, producer_epoch = producer_epoch + 1, next_producer_sequence = 0
					 WHERE path = ? AND closed = 0
					 RETURNING producer_epoch, next_offset, incarnation`,
					producerId,
					path,
				)
				.toArray()[0];
			if (!row) this.failForMissingOrClosed('acquire_producer', path);
			return {
				producerId,
				producerEpoch: row.producer_epoch as number,
				incarnation: row.incarnation as string,
				nextProducerSequence: 0,
				offset: formatOffset((row.next_offset as number) - 1),
			};
		});
	}

	async append(input: {
		path: string;
		producerId: string;
		producerEpoch: number;
		incarnation: string;
		producerSequence: number;
		expectedOffset?: string;
		submission?: { submissionId: string; attemptId: string };
		records: readonly ConversationRecord[];
	}): Promise<{ offset: string }> {
		if (input.records.length === 0) this.fail('append', input.path, 'A canonical batch cannot be empty.');
		const data = JSON.stringify(input.records);
		const result = this.runTransaction(() => {
			const meta = this.sql
				.exec(
					`SELECT next_offset, closed, producer_id, producer_epoch, next_producer_sequence, incarnation
					 FROM flue_conversation_streams WHERE path = ?`,
					input.path,
				)
				.toArray()[0];
			if (!meta) this.fail('append', input.path, 'Stream does not exist.');
			if (meta.closed === 1) this.fail('append', input.path, 'Stream is closed.');
			if (
				meta.producer_id !== input.producerId ||
				meta.producer_epoch !== input.producerEpoch ||
				meta.incarnation !== input.incarnation
			) {
				this.fail('append', input.path, 'Producer ownership is stale.');
			}
			const retry = this.sql
				.exec(
					`SELECT seq, data, submission_id, attempt_id FROM flue_conversation_stream_batches
					 WHERE path = ? AND producer_id = ? AND producer_epoch = ? AND producer_sequence = ?`,
					input.path,
					input.producerId,
					input.producerEpoch,
					input.producerSequence,
				)
				.toArray()[0];
			if (retry) {
				if (
					retry.data !== data ||
					retry.submission_id !== (input.submission?.submissionId ?? null) ||
					retry.attempt_id !== (input.submission?.attemptId ?? null)
				) {
					this.fail('append', input.path, 'Producer sequence has conflicting content.');
				}
				return { offset: formatOffset(retry.seq as number), appended: false };
			}
			if (meta.next_producer_sequence !== input.producerSequence) {
				this.fail('append', input.path, 'Producer sequence is not the next expected value.');
			}
			const head = formatOffset((meta.next_offset as number) - 1);
			if (input.expectedOffset !== undefined && input.expectedOffset !== head) {
				this.fail('append', input.path, 'Expected stream head does not match the current head.');
			}
			this.assertSubmissionAuthorization(input.path, input.submission, input.records);
			const seq = meta.next_offset as number;
			this.sql.exec(
				`INSERT INTO flue_conversation_stream_batches
				 (path, seq, producer_id, producer_epoch, producer_sequence, data, submission_id, attempt_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				input.path,
				seq,
				input.producerId,
				input.producerEpoch,
				input.producerSequence,
				data,
				input.submission?.submissionId ?? null,
				input.submission?.attemptId ?? null,
			);
			this.sql.exec(
				`UPDATE flue_conversation_streams
				 SET next_offset = next_offset + 1, next_producer_sequence = next_producer_sequence + 1
				 WHERE path = ?`,
				input.path,
			);
			return { offset: formatOffset(seq), appended: true };
		});
		if (result.appended) this.notify(input.path);
		return { offset: result.offset };
	}

	async read(
		path: string,
		options?: { offset?: string; limit?: number },
	): Promise<ConversationStreamReadResult> {
		const meta = await this.getMeta(path);
		if (!meta) return { batches: [], nextOffset: '-1', upToDate: true, closed: false };
		const rawOffset = options?.offset ?? '-1';
		if (rawOffset === 'now') {
			return { batches: [], nextOffset: meta.nextOffset, upToDate: true, closed: meta.closed };
		}
		const startAfter = parseOffset(rawOffset);
		const head = parseOffset(meta.nextOffset);
		if (!Number.isSafeInteger(startAfter) || startAfter > head) {
			this.fail('read', path, 'Read offset is beyond the canonical stream head.');
		}
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const rows = this.sql
			.exec(
				`SELECT seq, data FROM flue_conversation_stream_batches
				 WHERE path = ? AND seq > ? ORDER BY seq ASC LIMIT ?`,
				path,
				startAfter,
				limit + 1,
			)
			.toArray();
		const page = rows.slice(0, limit);
		const batches = page.map((row) => ({
			offset: formatOffset(row.seq as number),
			records: JSON.parse(row.data as string) as ConversationRecord[],
		}));
		return {
			batches,
			nextOffset: batches.at(-1)?.offset ?? formatOffset(startAfter),
			upToDate: rows.length <= limit,
			closed: meta.closed,
		};
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const row = this.sql
			.exec(
				`SELECT identity_json, next_offset, closed, producer_id, producer_epoch, next_producer_sequence, incarnation
				 FROM flue_conversation_streams WHERE path = ?`,
				path,
			)
			.toArray()[0];
		if (!row) return null;
		return {
			identity: JSON.parse(row.identity_json as string) as ConversationStreamIdentity,
			incarnation: row.incarnation as string,
			nextOffset: formatOffset((row.next_offset as number) - 1),
			closed: row.closed === 1,
			producerId: (row.producer_id as string | null) ?? null,
			producerEpoch: row.producer_epoch as number,
			nextProducerSequence: row.next_producer_sequence as number,
		};
	}

	async close(path: string): Promise<void> {
		this.sql.exec('UPDATE flue_conversation_streams SET closed = 1 WHERE path = ?', path);
		this.notify(path);
	}

	async delete(path: string): Promise<void> {
		this.runTransaction(() => {
			this.sql.exec('DELETE FROM flue_conversation_stream_batches WHERE path = ?', path);
			this.sql.exec('DELETE FROM flue_conversation_streams WHERE path = ?', path);
		});
		this.notify(path);
	}

	subscribe(path: string, listener: () => void): () => void {
		let listeners = this.listeners.get(path);
		if (!listeners) {
			listeners = new Set();
			this.listeners.set(path, listeners);
		}
		listeners.add(listener);
		return () => {
			listeners?.delete(listener);
			if (listeners?.size === 0) this.listeners.delete(path);
		};
	}

	private assertSubmissionAuthorization(
		path: string,
		submission: { submissionId: string; attemptId: string } | undefined,
		records: readonly ConversationRecord[],
	): void {
		const submissionRecords = records.filter(
			(record) => record.submissionId !== undefined || record.attemptId !== undefined,
		);
		if (!submission) {
			if (submissionRecords.length > 0) {
				this.fail('append', path, 'Submission-owned records require an attempt authorization.');
			}
			return;
		}
		if (
			submissionRecords.some(
				(record) =>
					record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId,
			)
		) {
			this.fail('append', path, 'Record ownership does not match the authorized submission attempt.');
		}
		const row = this.sql
			.exec(
				`SELECT status, attempt_id, session_key, settlement_record_id, settlement_record_json
				 FROM flue_agent_submissions WHERE submission_id = ?`,
				submission.submissionId,
			)
			.toArray()[0];
		const sessionIdentity = typeof row?.session_key === 'string'
			? parseSessionStorageKey(row.session_key)
			: undefined;
		const streamIdentity = this.sql
			.exec('SELECT identity_json FROM flue_conversation_streams WHERE path = ?', path)
			.toArray()[0];
		const instanceId = streamIdentity
			? (JSON.parse(streamIdentity.identity_json as string) as ConversationStreamIdentity).instanceId
			: undefined;
		const terminalizingSettlement =
			row?.status === 'terminalizing' &&
			records.length === 1 &&
			submissionRecords.length === 1 &&
			submissionRecords[0]?.type === 'submission_settled' &&
			row.settlement_record_id === submissionRecords[0].id &&
			row.settlement_record_json === JSON.stringify(submissionRecords[0]);
		if (
			!row ||
			(row.status !== 'running' && !terminalizingSettlement) ||
			row.attempt_id !== submission.attemptId ||
			!sessionIdentity ||
			sessionIdentity.instanceId !== instanceId
		) {
			this.fail('append', path, 'Submission attempt no longer owns work for this agent instance.');
		}
	}

	private failForMissingOrClosed(operation: string, path: string): never {
		const row = this.sql
			.exec('SELECT closed FROM flue_conversation_streams WHERE path = ?', path)
			.toArray()[0];
		this.fail(operation, path, row ? 'Stream is closed.' : 'Stream does not exist.');
	}

	private fail(operation: string, path: string, reason: string): never {
		throw new ConversationStreamStoreError({ operation, path, reason });
	}

	private notify(path: string): void {
		for (const listener of this.listeners.get(path) ?? []) {
			try {
				listener();
			} catch {}
		}
	}
}
