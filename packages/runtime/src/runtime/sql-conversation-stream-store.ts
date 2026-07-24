import { clampLimit } from '../adapter-helpers.ts';
import type { ConversationRecord } from '../conversation-records.ts';
import { ConversationStreamStoreError } from '../errors.ts';
import { parseSessionStorageKey } from '../session-identity.ts';
import {
	type ConversationProducerClaim,
	type ConversationStreamIdentity,
	type ConversationStreamMeta,
	type ConversationStreamReadResult,
	type ConversationStreamStore,
	StreamListenerRegistry,
} from './conversation-stream-store.ts';
import { generateIncarnationId } from './ids.ts';
import { DEFAULT_READ_LIMIT, formatOffset, MAX_READ_LIMIT, parseOffset } from './stream-offsets.ts';

/**
 * A query inside a {@link SqlConversationDialect} transaction: a SQL string
 * built from dialect placeholders plus positional parameters, resolving to
 * result rows as plain objects.
 */
export interface SqlConversationDialectTx {
	query(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
}

/**
 * The async SQL dialect seam that {@link defineSqlConversationStreamStore} runs
 * the canonical conversation-stream fence against. A backend supplies its own
 * placeholder syntax, row-locking clause, upsert spelling, and `RETURNING`
 * support so the Postgres / libSQL / MySQL adapters share one fence
 * implementation rather than hand-copying it.
 */
export interface SqlConversationDialect {
	/** Render a 1-based positional placeholder (pg: `$N`; libsql/mysql: `?`). */
	placeholder(index1Based: number): string;
	/** Appended to row-locking SELECTs (`FOR UPDATE` for pg/mysql; `''` for libsql). */
	readonly lockClause: string;
	/** Leading keywords for the createStream insert (`INSERT` or `INSERT IGNORE`). */
	readonly insertIgnorePrefix: string;
	/** Trailing clause for the createStream insert (`ON CONFLICT (path) DO NOTHING` or `''`). */
	readonly insertIgnoreSuffix: string;
	/** Whether the backend supports `UPDATE ... RETURNING` (pg/libsql) or not (mysql). */
	readonly supportsReturning: boolean;
	/** Inline the read `LIMIT` as a literal rather than a placeholder (mysql). */
	readonly inlineReadLimit?: boolean;
	/** Optional per-operation path validation (mysql enforces a length limit). */
	validatePath?(path: string, operation: string): void;
	query(sql: string, params: readonly unknown[]): Promise<Record<string, unknown>[]>;
	transaction<T>(fn: (tx: SqlConversationDialectTx) => Promise<T>): Promise<T>;
}

/**
 * Build a {@link ConversationStreamStore} over an async SQL backend described by
 * {@link SqlConversationDialect}. The fence algorithm — producer epoch / incarnation
 * staleness checks, idempotent retry detection, sequence-gap rejection, and
 * submission-authorization — is identical across Postgres, libSQL, and MySQL; only
 * the dialect constants differ.
 */
export function defineSqlConversationStreamStore(
	dialect: SqlConversationDialect,
): ConversationStreamStore {
	return new SqlConversationStreamStore(dialect);
}

class SqlConversationStreamStore implements ConversationStreamStore {
	private listeners = new StreamListenerRegistry();

	constructor(private dialect: SqlConversationDialect) {}

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const dialect = this.dialect;
		const p = (index: number) => dialect.placeholder(index);
		dialect.validatePath?.(path, 'create');
		const data = JSON.stringify(identity);
		await dialect.transaction(async (tx) => {
			await tx.query(
				`${dialect.insertIgnorePrefix} INTO flue_conversation_streams (path, identity_json, incarnation)
				 VALUES (${p(1)}, ${p(2)}, ${p(3)}) ${dialect.insertIgnoreSuffix}`,
				[path, data, generateIncarnationId()],
			);
			const rows = await tx.query(
				`SELECT identity_json FROM flue_conversation_streams WHERE path = ${p(1)}`,
				[path],
			);
			if (rows[0]?.identity_json !== data)
				throw failure(path, 'Stream identity conflicts.', 'create');
		});
	}

	async acquireProducer(path: string, producerId: string): Promise<ConversationProducerClaim> {
		const dialect = this.dialect;
		const p = (index: number) => dialect.placeholder(index);
		dialect.validatePath?.(path, 'acquire_producer');
		return dialect.transaction(async (tx) => {
			if (dialect.supportsReturning) {
				const rows = await tx.query(
					`UPDATE flue_conversation_streams
					 SET producer_id = ${p(1)}, producer_epoch = producer_epoch + 1, next_producer_sequence = 0
					 WHERE path = ${p(2)}
					 RETURNING producer_epoch, next_offset, incarnation`,
					[producerId, path],
				);
				const row = rows[0];
				if (!row) throw failure(path, 'Stream does not exist.', 'acquire_producer');
				return {
					producerId,
					producerEpoch: Number(row.producer_epoch),
					incarnation: String(row.incarnation),
					nextProducerSequence: 0,
					offset: formatOffset(Number(row.next_offset) - 1),
				};
			}
			const rows = await tx.query(
				`SELECT next_offset, producer_epoch, incarnation
				 FROM flue_conversation_streams WHERE path = ${p(1)} ${dialect.lockClause}`,
				[path],
			);
			const row = rows[0];
			if (!row) throw failure(path, 'Stream does not exist.', 'acquire_producer');
			const producerEpoch = Number(row.producer_epoch) + 1;
			await tx.query(
				`UPDATE flue_conversation_streams
				 SET producer_id = ${p(1)}, producer_epoch = ${p(2)}, next_producer_sequence = 0
				 WHERE path = ${p(3)}`,
				[producerId, producerEpoch, path],
			);
			return {
				producerId,
				producerEpoch,
				incarnation: String(row.incarnation),
				nextProducerSequence: 0,
				offset: formatOffset(Number(row.next_offset) - 1),
			};
		});
	}

	async append(input: {
		path: string;
		producerId: string;
		producerEpoch: number;
		incarnation: string;
		producerSequence: number;
		submission?: { submissionId: string; attemptId: string };
		records: readonly ConversationRecord[];
	}): Promise<{ offset: string }> {
		const dialect = this.dialect;
		const p = (index: number) => dialect.placeholder(index);
		dialect.validatePath?.(input.path, 'append');
		if (input.records.length === 0)
			throw failure(input.path, 'A canonical batch cannot be empty.', 'append');
		const data = JSON.stringify(input.records);
		if (data.length > MAX_BATCH_DATA_LENGTH) {
			throw failure(input.path, oversizedBatchReason(data.length, input.records));
		}
		const result = await dialect.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT next_offset, producer_id, producer_epoch, next_producer_sequence, incarnation
				 FROM flue_conversation_streams WHERE path = ${p(1)} ${dialect.lockClause}`,
				[input.path],
			);
			const meta = rows[0];
			if (!meta) throw failure(input.path, 'Stream does not exist.');
			if (
				meta.producer_id !== input.producerId ||
				Number(meta.producer_epoch) !== input.producerEpoch ||
				meta.incarnation !== input.incarnation
			) {
				throw failure(input.path, 'Producer ownership is stale.');
			}
			const retries = await tx.query(
				`SELECT seq, data, submission_id, attempt_id FROM flue_conversation_stream_batches
				 WHERE path = ${p(1)} AND producer_id = ${p(2)} AND producer_epoch = ${p(3)} AND producer_sequence = ${p(4)}`,
				[input.path, input.producerId, input.producerEpoch, input.producerSequence],
			);
			const retry = retries[0];
			if (retry) {
				if (
					retry.data !== data ||
					(retry.submission_id ?? null) !== (input.submission?.submissionId ?? null) ||
					(retry.attempt_id ?? null) !== (input.submission?.attemptId ?? null)
				) {
					throw failure(input.path, 'Producer sequence has conflicting content.');
				}
				return { offset: formatOffset(Number(retry.seq)), appended: false };
			}
			if (Number(meta.next_producer_sequence) !== input.producerSequence) {
				throw failure(input.path, 'Producer sequence is not the next expected value.');
			}
			await assertSubmissionAuthorization(dialect, tx, input.path, input.submission, input.records);
			const seq = Number(meta.next_offset);
			await tx.query(
				`INSERT INTO flue_conversation_stream_batches
				 (path, seq, producer_id, producer_epoch, producer_sequence, data, submission_id, attempt_id)
				 VALUES (${p(1)}, ${p(2)}, ${p(3)}, ${p(4)}, ${p(5)}, ${p(6)}, ${p(7)}, ${p(8)})`,
				[
					input.path,
					seq,
					input.producerId,
					input.producerEpoch,
					input.producerSequence,
					data,
					input.submission?.submissionId ?? null,
					input.submission?.attemptId ?? null,
				],
			);
			await tx.query(
				`UPDATE flue_conversation_streams
				 SET next_offset = next_offset + 1, next_producer_sequence = next_producer_sequence + 1
				 WHERE path = ${p(1)}`,
				[input.path],
			);
			return { offset: formatOffset(seq), appended: true };
		});
		if (result.appended) this.listeners.notify(input.path);
		return { offset: result.offset };
	}

	async read(
		path: string,
		options?: { offset?: string; limit?: number },
	): Promise<ConversationStreamReadResult> {
		const dialect = this.dialect;
		const p = (index: number) => dialect.placeholder(index);
		dialect.validatePath?.(path, 'read');
		const meta = await this.getMeta(path);
		if (!meta) return { batches: [], nextOffset: '-1', upToDate: true };
		const rawOffset = options?.offset ?? '-1';
		if (rawOffset === 'now') return { batches: [], nextOffset: meta.nextOffset, upToDate: true };
		const startAfter = parseOffset(rawOffset);
		if (!Number.isSafeInteger(startAfter) || startAfter > parseOffset(meta.nextOffset)) {
			throw failure(path, 'Read offset is beyond the canonical stream head.', 'read');
		}
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const limitSql = dialect.inlineReadLimit ? `${limit + 1}` : p(3);
		const params = dialect.inlineReadLimit ? [path, startAfter] : [path, startAfter, limit + 1];
		const rows = await dialect.query(
			`SELECT seq, data FROM flue_conversation_stream_batches
			 WHERE path = ${p(1)} AND seq > ${p(2)} ORDER BY seq ASC LIMIT ${limitSql}`,
			params,
		);
		const page = rows.slice(0, limit);
		const batches = page.map((row) => ({
			offset: formatOffset(Number(row.seq)),
			records: JSON.parse(String(row.data)) as ConversationRecord[],
		}));
		return {
			batches,
			nextOffset: batches.at(-1)?.offset ?? formatOffset(startAfter),
			upToDate: rows.length <= limit,
		};
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const dialect = this.dialect;
		const p = (index: number) => dialect.placeholder(index);
		dialect.validatePath?.(path, 'get_meta');
		const rows = await dialect.query(
			`SELECT identity_json, next_offset, producer_id, producer_epoch, next_producer_sequence, incarnation
			 FROM flue_conversation_streams WHERE path = ${p(1)}`,
			[path],
		);
		const row = rows[0];
		if (!row) return null;
		return {
			identity: JSON.parse(String(row.identity_json)) as ConversationStreamIdentity,
			incarnation: String(row.incarnation),
			nextOffset: formatOffset(Number(row.next_offset) - 1),
			producerId: row.producer_id == null ? null : String(row.producer_id),
			producerEpoch: Number(row.producer_epoch),
			nextProducerSequence: Number(row.next_producer_sequence),
		};
	}

	subscribe(path: string, listener: () => void): () => void {
		return this.listeners.subscribe(path, listener);
	}
}

async function assertSubmissionAuthorization(
	dialect: SqlConversationDialect,
	tx: SqlConversationDialectTx,
	path: string,
	submission: { submissionId: string; attemptId: string } | undefined,
	records: readonly ConversationRecord[],
): Promise<void> {
	const p = (index: number) => dialect.placeholder(index);
	const owned = records.filter(
		(record) => record.submissionId !== undefined || record.attemptId !== undefined,
	);
	if (!submission) {
		if (owned.length > 0)
			throw failure(path, 'Submission-owned records require attempt authorization.');
		return;
	}
	for (const record of owned) {
		if (
			record.submissionId === submission.submissionId &&
			record.attemptId === submission.attemptId
		) {
			continue;
		}
		// Turn-boundary join: the host attempt writes a joined delivery's input
		// and adoption records under its own authority. Legal exactly when the
		// delivery's row is durably claimed by THIS host (`joining`/`joined`
		// with `joined_into` = the authorized submission) and the record still
		// carries the host's attempt.
		if (record.attemptId === submission.attemptId && record.submissionId !== undefined) {
			const deliveries = await tx.query(
				`SELECT status, joined_into FROM flue_agent_submissions WHERE submission_id = ${p(1)}`,
				[record.submissionId],
			);
			const delivery = deliveries[0];
			if (
				(delivery?.status === 'joining' || delivery?.status === 'joined') &&
				delivery.joined_into === submission.submissionId
			) {
				continue;
			}
		}
		throw failure(path, 'Record ownership does not match the authorized submission attempt.');
	}
	const rows = await tx.query(
		`SELECT status, attempt_id, session_key, settlement_record_id, settlement_record
		 FROM flue_agent_submissions WHERE submission_id = ${p(1)} ${dialect.lockClause}`,
		[submission.submissionId],
	);
	const row = rows[0];
	const streams = await tx.query(
		`SELECT identity_json FROM flue_conversation_streams WHERE path = ${p(1)}`,
		[path],
	);
	const streamIdentity = streams[0]
		? (JSON.parse(String(streams[0].identity_json)) as ConversationStreamIdentity)
		: undefined;
	const terminalizingSettlement =
		row?.status === 'terminalizing' &&
		records.length === 1 &&
		owned.length === 1 &&
		owned[0]?.type === 'submission_settled' &&
		row.settlement_record_id === owned[0].id &&
		row.settlement_record === JSON.stringify(owned[0]);
	const sessionIdentity =
		typeof row?.session_key === 'string' ? parseSessionStorageKey(row.session_key) : undefined;
	if (
		!row ||
		(row.status !== 'running' && !terminalizingSettlement) ||
		row.attempt_id !== submission.attemptId ||
		!sessionIdentity ||
		!streamIdentity ||
		sessionIdentity.agentName !== streamIdentity.agentName ||
		sessionIdentity.instanceId !== streamIdentity.instanceId
	) {
		throw failure(path, 'Submission attempt no longer owns work for this agent instance.');
	}
}

function failure(path: string, reason: string, operation = 'append'): ConversationStreamStoreError {
	return new ConversationStreamStoreError({ operation, path, reason });
}

/**
 * Ceiling on one serialized batch, generous by an order of magnitude: a 2MB
 * record already approximates 200k tokens against a 1M-token maximum context
 * window, so a batch past 12MB indicates an unbounded tool result or message
 * rather than real conversation data.
 */
const MAX_BATCH_DATA_LENGTH = 12 * 1024 * 1024;

// The same per-append ceiling guards the Durable Object SQLite store
// (conversation-stream-store.ts) and the MongoDB conversation store.
function oversizedBatchReason(dataLength: number, records: readonly ConversationRecord[]): string {
	const mb = (length: number) => `${(length / (1024 * 1024)).toFixed(1)}MB`;
	let largest = records[0] as ConversationRecord;
	let largestLength = 0;
	for (const record of records) {
		const length = JSON.stringify(record).length;
		if (length > largestLength) {
			largest = record;
			largestLength = length;
		}
	}
	return `The batch serializes to ~${mb(dataLength)}, above the 12MB per-append ceiling. The largest record is a "${largest.type}" record (id "${largest.id}") at ~${mb(largestLength)}. Oversized tool results and message content must be truncated before they are recorded (built-in tools cap results at 50KB).`;
}
