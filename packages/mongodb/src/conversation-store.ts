import type {
	ConversationRecord,
	ConversationStreamIdentity,
	ConversationStreamMeta,
	ConversationStreamReadResult,
	ConversationStreamStore,
} from '@flue/runtime/adapter';
import {
	ConversationStreamStoreError,
	clampLimit,
	DEFAULT_READ_LIMIT,
	formatOffset,
	MAX_READ_LIMIT,
	parseOffset,
} from '@flue/runtime/adapter';
import type { MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';

export class MongoConversationStreamStore implements ConversationStreamStore {
	private listeners = new Map<string, Set<() => void>>();

	constructor(private runner: MongoRunner, private prefix: string) {}

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const streams = this.streams();
		try {
			await streams.updateOne(
				{ _id: path },
				{
					$setOnInsert: {
						identity,
						nextOffset: 0,
						closed: false,
						producerId: null,
						producerEpoch: 0,
						nextProducerSequence: 0,
						incarnation: crypto.randomUUID(),
					},
				},
				{ upsert: true },
			);
		} catch (error) {
			if (!isDuplicateKeyError(error)) throw error;
		}
		const winner = await streams.findOne({ _id: path });
		if (!winner) throw failure(path, 'Stream creation did not return the persisted identity.', 'create');
		if (JSON.stringify(winner.identity) !== JSON.stringify(identity)) {
			throw failure(path, 'Stream identity conflicts.', 'create');
		}
	}

	async acquireProducer(path: string, producerId: string) {
		return this.runner.transaction(async (tx) => {
			const row = await tx.collection(collectionName(this.prefix, 'conversation_streams')).findOneAndUpdate(
				{ _id: path, closed: false },
				{ $set: { producerId, nextProducerSequence: 0 }, $inc: { producerEpoch: 1 } },
				{ returnDocument: 'after' },
			);
			if (!row) throw failure(path, 'Stream does not exist or is closed.');
			return { producerId, producerEpoch: Number(row.producerEpoch), incarnation: String(row.incarnation), nextProducerSequence: 0, offset: formatOffset(Number(row.nextOffset) - 1) };
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
			const streams = tx.collection(collectionName(this.prefix, 'conversation_streams'));
			const meta = await streams.findOne({ _id: input.path });
			if (!meta || meta.closed) throw failure(input.path, 'Stream does not exist or is closed.');
			if (meta.producerId !== input.producerId || Number(meta.producerEpoch) !== input.producerEpoch || meta.incarnation !== input.incarnation) throw failure(input.path, 'Producer ownership is stale.');
			const batches = tx.collection(collectionName(this.prefix, 'conversation_batches'));
			const retry = await batches.findOne({ path: input.path, producerId: input.producerId, producerEpoch: input.producerEpoch, producerSequence: input.producerSequence });
			if (retry) {
				if (retry.data !== data || (retry.submissionId ?? null) !== (input.submission?.submissionId ?? null) || (retry.attemptId ?? null) !== (input.submission?.attemptId ?? null)) throw failure(input.path, 'Producer sequence has conflicting content.');
				return { offset: formatOffset(Number(retry.offset)), appended: false };
			}
			if (Number(meta.nextProducerSequence) !== input.producerSequence) throw failure(input.path, 'Producer sequence is not the next expected value.');
			const head = formatOffset(Number(meta.nextOffset) - 1);
			if (input.expectedOffset !== undefined && input.expectedOffset !== head) throw failure(input.path, 'Expected stream head does not match the current head.');
			await assertSubmissionAuthorization(
				tx,
				this.prefix,
				input.path,
				(meta.identity as ConversationStreamIdentity).instanceId,
				input.submission,
				input.records,
			);
			const offset = Number(meta.nextOffset);
			await batches.insertOne({ _id: `${input.path}:${offset}`, path: input.path, offset, producerId: input.producerId, producerEpoch: input.producerEpoch, producerSequence: input.producerSequence, data, submissionId: input.submission?.submissionId ?? null, attemptId: input.submission?.attemptId ?? null });
			const updated = await streams.updateOne(
				{ _id: input.path, producerId: input.producerId, producerEpoch: input.producerEpoch, incarnation: input.incarnation, nextOffset: offset, nextProducerSequence: input.producerSequence },
				{ $inc: { nextOffset: 1, nextProducerSequence: 1 } },
			);
			if (updated.modifiedCount !== 1) throw failure(input.path, 'Producer ownership changed during append.');
			return { offset: formatOffset(offset), appended: true };
		});
		if (result.appended) this.notify(input.path);
		return { offset: result.offset };
	}

	async read(path: string, options?: { offset?: string; limit?: number }): Promise<ConversationStreamReadResult> {
		const meta = await this.getMeta(path);
		if (!meta) return { batches: [], nextOffset: '-1', upToDate: true, closed: false };
		const rawOffset = options?.offset ?? '-1';
		if (rawOffset === 'now') return { batches: [], nextOffset: meta.nextOffset, upToDate: true, closed: meta.closed };
		const start = parseOffset(rawOffset);
		if (!Number.isSafeInteger(start) || start > parseOffset(meta.nextOffset)) throw failure(path, 'Read offset is beyond the canonical stream head.');
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const rows = await this.batches().find({ path, offset: { $gt: start } }, { sort: { offset: 1 }, limit: limit + 1 });
		const page = rows.slice(0, limit);
		const batches = page.map((row) => ({ offset: formatOffset(Number(row.offset)), records: JSON.parse(String(row.data)) as ConversationRecord[] }));
		return { batches, nextOffset: batches.at(-1)?.offset ?? formatOffset(start), upToDate: rows.length <= limit, closed: meta.closed };
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const row = await this.streams().findOne({ _id: path });
		if (!row) return null;
		return { identity: row.identity as ConversationStreamIdentity, incarnation: String(row.incarnation), nextOffset: formatOffset(Number(row.nextOffset) - 1), closed: Boolean(row.closed), producerId: row.producerId == null ? null : String(row.producerId), producerEpoch: Number(row.producerEpoch), nextProducerSequence: Number(row.nextProducerSequence) };
	}

	async close(path: string): Promise<void> {
		await this.streams().updateOne({ _id: path }, { $set: { closed: true } });
		this.notify(path);
	}

	async delete(path: string): Promise<void> {
		await this.runner.transaction(async (tx) => {
			await tx.collection(collectionName(this.prefix, 'conversation_batches')).deleteMany({ path });
			await tx.collection(collectionName(this.prefix, 'conversation_streams')).deleteOne({ _id: path });
		});
		this.notify(path);
	}

	subscribe(path: string, listener: () => void): () => void {
		const listeners = this.listeners.get(path) ?? new Set();
		listeners.add(listener);
		this.listeners.set(path, listeners);
		return () => { listeners.delete(listener); if (listeners.size === 0) this.listeners.delete(path); };
	}

	private streams() { return this.runner.collection(collectionName(this.prefix, 'conversation_streams')); }
	private batches() { return this.runner.collection(collectionName(this.prefix, 'conversation_batches')); }
	private notify(path: string) { for (const listener of this.listeners.get(path) ?? []) { try { listener(); } catch {} } }
}

async function assertSubmissionAuthorization(
	tx: MongoOperations,
	prefix: string,
	path: string,
	instanceId: string,
	submission: { submissionId: string; attemptId: string } | undefined,
	records: readonly ConversationRecord[],
): Promise<void> {
	const owned = records.filter((record) => record.submissionId !== undefined || record.attemptId !== undefined);
	if (!submission) { if (owned.length > 0) throw failure(path, 'Submission-owned records require attempt authorization.'); return; }
	if (owned.some((record) => record.submissionId !== submission.submissionId || record.attemptId !== submission.attemptId)) throw failure(path, 'Record ownership does not match the authorized submission attempt.');
	const submissions = tx.collection(collectionName(prefix, 'submissions'));
	const row = await submissions.findOne({
		submissionId: submission.submissionId,
		attemptId: submission.attemptId,
	});
	const terminalizingSettlement =
		row?.status === 'terminalizing' &&
		records.length === 1 &&
		owned.length === 1 &&
		owned[0]?.type === 'submission_settled' &&
		row.settlementRecordId === owned[0].id &&
		JSON.stringify(row.settlementRecord) === JSON.stringify(owned[0]);
	if (!row || (row.status !== 'running' && !terminalizingSettlement) || parseSessionInstance(row.sessionKey) !== instanceId) {
		throw failure(path, 'Submission attempt no longer owns work for this agent instance.');
	}
	const ownership = terminalizingSettlement
		? { status: 'terminalizing', settlementRecordId: owned[0]?.id, settlementRecord: row.settlementRecord }
		: { status: 'running' };
	const fenced = await submissions.updateOne(
		{ _id: row._id, attemptId: submission.attemptId, ...ownership },
		{ $inc: { conversationWriteRevision: 1 } },
	);
	if (fenced.modifiedCount !== 1) {
		throw failure(path, 'Submission attempt ownership changed during append.');
	}
}

function parseSessionInstance(value: unknown): string | undefined {
	if (typeof value !== 'string' || !value.startsWith('agent-session:')) return undefined;
	try { const parsed = JSON.parse(value.slice('agent-session:'.length)) as unknown; return Array.isArray(parsed) && typeof parsed[0] === 'string' ? parsed[0] : undefined; } catch { return undefined; }
}

function isDuplicateKeyError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function failure(
	path: string,
	reason: string,
	operation = 'conversation_stream',
): ConversationStreamStoreError {
	return new ConversationStreamStoreError({ operation, path, reason });
}
