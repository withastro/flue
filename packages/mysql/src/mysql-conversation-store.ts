import type {
	ConversationRecord,
	ConversationSnapshot,
	ConversationSnapshotStore,
	ConversationStreamIdentity,
	ConversationStreamMeta,
	ConversationStreamReadResult,
	ConversationStreamStore,
} from '@flue/runtime/adapter';
import { clampLimit, DEFAULT_READ_LIMIT, formatOffset, MAX_READ_LIMIT, parseOffset } from '@flue/runtime/adapter';
import type { MysqlQuery, MysqlRunner } from './mysql-adapter.ts';

export class MysqlConversationStreamStore implements ConversationStreamStore {
	private listeners = new Map<string, Set<() => void>>();

	constructor(private runner: MysqlRunner) {}

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const data = JSON.stringify(identity);
		await this.runner.transaction(async (tx) => {
			const rows = await tx.query('SELECT identity_json FROM flue_conversation_streams WHERE path = ? FOR UPDATE', [path]);
			if (rows[0]) {
				if (rows[0].identity_json !== data) throw failure(path, 'Stream identity conflicts.');
				return;
			}
			await tx.query('INSERT INTO flue_conversation_streams (path, identity_json, incarnation) VALUES (?, ?, ?)', [path, data, crypto.randomUUID()]);
		});
	}

	async acquireProducer(path: string, producerId: string) {
		return this.runner.transaction(async (tx) => {
			const rows = await tx.query('SELECT next_offset, closed, producer_epoch, incarnation FROM flue_conversation_streams WHERE path = ? FOR UPDATE', [path]);
			const row = rows[0];
			if (!row || Number(row.closed) !== 0) throw failure(path, 'Stream does not exist or is closed.');
			const producerEpoch = Number(row.producer_epoch) + 1;
			await tx.query('UPDATE flue_conversation_streams SET producer_id = ?, producer_epoch = ?, next_producer_sequence = 0 WHERE path = ?', [producerId, producerEpoch, path]);
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
		expectedOffset?: string;
		submission?: { submissionId: string; attemptId: string };
		records: readonly ConversationRecord[];
	}): Promise<{ offset: string }> {
		if (input.records.length === 0) throw failure(input.path, 'A canonical batch cannot be empty.');
		const data = JSON.stringify(input.records);
		const result = await this.runner.transaction(async (tx) => {
			const rows = await tx.query(
				`SELECT next_offset, closed, producer_id, producer_epoch, next_producer_sequence, incarnation
				 FROM flue_conversation_streams WHERE path = ? FOR UPDATE`,
				[input.path],
			);
			const meta = rows[0];
			if (!meta || Number(meta.closed) !== 0) throw failure(input.path, 'Stream does not exist or is closed.');
			if (meta.producer_id !== input.producerId || Number(meta.producer_epoch) !== input.producerEpoch || meta.incarnation !== input.incarnation) throw failure(input.path, 'Producer ownership is stale.');
			const retries = await tx.query(
				`SELECT seq, data, submission_id, attempt_id FROM flue_conversation_stream_batches
				 WHERE path = ? AND producer_id = ? AND producer_epoch = ? AND producer_sequence = ? FOR UPDATE`,
				[input.path, input.producerId, input.producerEpoch, input.producerSequence],
			);
			const retry = retries[0];
			if (retry) {
				if (retry.data !== data || (retry.submission_id ?? null) !== (input.submission?.submissionId ?? null) || (retry.attempt_id ?? null) !== (input.submission?.attemptId ?? null)) throw failure(input.path, 'Producer sequence has conflicting content.');
				return { offset: formatOffset(Number(retry.seq)), appended: false };
			}
			if (Number(meta.next_producer_sequence) !== input.producerSequence) throw failure(input.path, 'Producer sequence is not the next expected value.');
			const head = formatOffset(Number(meta.next_offset) - 1);
			if (input.expectedOffset !== undefined && input.expectedOffset !== head) throw failure(input.path, 'Expected stream head does not match the current head.');
			await assertSubmissionAuthorization(tx.query, input.path, input.submission, input.records);
			const seq = Number(meta.next_offset);
			await tx.query(
				`INSERT INTO flue_conversation_stream_batches
				 (path, seq, producer_id, producer_epoch, producer_sequence, data, submission_id, attempt_id)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
				[input.path, seq, input.producerId, input.producerEpoch, input.producerSequence, data, input.submission?.submissionId ?? null, input.submission?.attemptId ?? null],
			);
			await tx.query('UPDATE flue_conversation_streams SET next_offset = next_offset + 1, next_producer_sequence = next_producer_sequence + 1 WHERE path = ?', [input.path]);
			return { offset: formatOffset(seq), appended: true };
		});
		if (result.appended) this.notify(input.path);
		return { offset: result.offset };
	}

	async read(path: string, options?: { offset?: string; limit?: number }): Promise<ConversationStreamReadResult> {
		const meta = await this.getMeta(path);
		if (!meta) return { batches: [], nextOffset: '-1', upToDate: true, closed: false };
		const rawOffset = options?.offset ?? '-1';
		if (rawOffset === 'now') return { batches: [], nextOffset: meta.nextOffset, upToDate: true, closed: meta.closed };
		const startAfter = parseOffset(rawOffset);
		if (!Number.isSafeInteger(startAfter) || startAfter > parseOffset(meta.nextOffset)) throw failure(path, 'Read offset is beyond the canonical stream head.');
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const rows = await this.runner.query(`SELECT seq, data FROM flue_conversation_stream_batches WHERE path = ? AND seq > ? ORDER BY seq ASC LIMIT ${limit + 1}`, [path, startAfter]);
		const page = rows.slice(0, limit);
		const batches = page.map((row) => ({ offset: formatOffset(Number(row.seq)), records: JSON.parse(String(row.data)) as ConversationRecord[] }));
		return { batches, nextOffset: batches.at(-1)?.offset ?? formatOffset(startAfter), upToDate: rows.length <= limit, closed: meta.closed };
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const rows = await this.runner.query('SELECT identity_json, next_offset, closed, producer_id, producer_epoch, next_producer_sequence, incarnation FROM flue_conversation_streams WHERE path = ?', [path]);
		const row = rows[0];
		if (!row) return null;
		return {
			identity: JSON.parse(String(row.identity_json)) as ConversationStreamIdentity,
			incarnation: String(row.incarnation),
			nextOffset: formatOffset(Number(row.next_offset) - 1),
			closed: Number(row.closed) !== 0,
			producerId: row.producer_id == null ? null : String(row.producer_id),
			producerEpoch: Number(row.producer_epoch),
			nextProducerSequence: Number(row.next_producer_sequence),
		};
	}

	async close(path: string): Promise<void> {
		await this.runner.query('UPDATE flue_conversation_streams SET closed = 1 WHERE path = ?', [path]);
		this.notify(path);
	}

	async delete(path: string): Promise<void> {
		await this.runner.transaction(async (tx) => {
			await tx.query('DELETE FROM flue_conversation_snapshots WHERE path = ?', [path]);
			await tx.query('DELETE FROM flue_conversation_stream_batches WHERE path = ?', [path]);
			await tx.query('DELETE FROM flue_conversation_streams WHERE path = ?', [path]);
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

	private notify(path: string): void {
		for (const listener of this.listeners.get(path) ?? []) {
			try { listener(); } catch {}
		}
	}
}

export class MysqlConversationSnapshotStore<State = unknown> implements ConversationSnapshotStore<State> {
	constructor(private runner: MysqlRunner) {}

	async load(path: string): Promise<ConversationSnapshot<State> | null> {
		const rows = await this.runner.query('SELECT data FROM flue_conversation_snapshots WHERE path = ?', [path]);
		return rows[0] ? (JSON.parse(String(rows[0].data)) as ConversationSnapshot<State>) : null;
	}

	async save(path: string, snapshot: ConversationSnapshot<State>): Promise<void> {
		await this.runner.transaction(async (tx) => {
			const rows = await tx.query('SELECT next_offset, incarnation FROM flue_conversation_streams WHERE path = ? FOR UPDATE', [path]);
			const meta = rows[0];
			if (!meta) throw failure(path, 'Stream does not exist.');
			if (snapshot.streamIncarnation !== meta.incarnation) throw failure(path, 'Snapshot stream incarnation is stale.');
			if (parseOffset(snapshot.streamOffset) > Number(meta.next_offset) - 1) throw failure(path, 'Snapshot offset is beyond the stream head.');
			await tx.query(
				`INSERT INTO flue_conversation_snapshots (path, reducer_version, stream_offset, data, created_at)
				 VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE reducer_version = VALUES(reducer_version),
				 stream_offset = VALUES(stream_offset), data = VALUES(data), created_at = VALUES(created_at)`,
				[path, snapshot.reducerVersion, snapshot.streamOffset, JSON.stringify(snapshot), snapshot.createdAt],
			);
		});
	}

	async delete(path: string): Promise<void> {
		await this.runner.query('DELETE FROM flue_conversation_snapshots WHERE path = ?', [path]);
	}
}

async function assertSubmissionAuthorization(query: MysqlQuery, path: string, submission: { submissionId: string; attemptId: string } | undefined, records: readonly ConversationRecord[]): Promise<void> {
	const owned = records.filter((record) => record.submissionId !== undefined || record.attemptId !== undefined);
	if (!submission) {
		if (owned.length > 0) throw failure(path, 'Submission-owned records require attempt authorization.');
		return;
	}
	if (owned.some((record) => record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId)) throw failure(path, 'Record ownership does not match the authorized submission attempt.');
	const rows = await query('SELECT status, attempt_id, session_key, settlement_record_id, settlement_record FROM flue_agent_submissions WHERE submission_id = ? FOR UPDATE', [submission.submissionId]);
	const row = rows[0];
	const streams = await query('SELECT identity_json FROM flue_conversation_streams WHERE path = ?', [path]);
	const streamIdentity = streams[0] ? JSON.parse(String(streams[0].identity_json)) as ConversationStreamIdentity : undefined;
	const terminalizingSettlement =
		row?.status === 'terminalizing' &&
		records.length === 1 &&
		owned.length === 1 &&
		owned[0]?.type === 'submission_settled' &&
		row.settlement_record_id === owned[0].id &&
		row.settlement_record === JSON.stringify(owned[0]);
	if (!row || (row.status !== 'running' && !terminalizingSettlement) || row.attempt_id !== submission.attemptId || parseSessionInstance(row.session_key) !== streamIdentity?.instanceId) throw failure(path, 'Submission attempt no longer owns work for this agent instance.');
}

function parseSessionInstance(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.startsWith('agent-session:')) return undefined;
	try {
		const parsed = JSON.parse(value.slice('agent-session:'.length)) as unknown;
		return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined;
	} catch { return undefined; }
}

function failure(path: string, reason: string): TypeError {
	return new TypeError(`[flue] Canonical conversation stream "${path}" failed: ${reason}`);
}
