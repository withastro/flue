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
	parseSessionStorageKey,
	StreamListenerRegistry,
} from '@flue/runtime/adapter';
import { ulid } from 'ulidx';
import type { MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';

export class MongoConversationStreamStore implements ConversationStreamStore {
	private listeners = new StreamListenerRegistry();

	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {}

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const streams = this.streams();
		try {
			await streams.updateOne(
				{ _id: path },
				{
					$setOnInsert: {
						identity,
						nextOffset: 0,
						producerId: null,
						producerEpoch: 0,
						nextProducerSequence: 0,
						incarnation: `inc_${ulid()}`,
					},
				},
				{ upsert: true },
			);
		} catch (error) {
			if (!isDuplicateKeyError(error)) throw error;
		}
		const winner = await streams.findOne({ _id: path });
		if (!winner)
			throw failure('create', path, 'Stream creation did not return the persisted identity.');
		if (JSON.stringify(winner.identity) !== JSON.stringify(identity)) {
			throw failure('create', path, 'Stream identity conflicts.');
		}
	}

	async acquireProducer(path: string, producerId: string) {
		return this.runner.transaction(async (tx) => {
			const row = await tx
				.collection(collectionName(this.prefix, 'conversation_streams'))
				.findOneAndUpdate(
					{ _id: path },
					{ $set: { producerId, nextProducerSequence: 0 }, $inc: { producerEpoch: 1 } },
					{ returnDocument: 'after' },
				);
			if (!row) throw failure('acquire_producer', path, 'Stream does not exist.');
			return {
				producerId,
				producerEpoch: Number(row.producerEpoch),
				incarnation: String(row.incarnation),
				nextProducerSequence: 0,
				offset: formatOffset(Number(row.nextOffset) - 1),
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
		if (input.records.length === 0)
			throw failure('append', input.path, 'A canonical batch cannot be empty.');
		const data = JSON.stringify(input.records);
		if (data.length > MAX_BATCH_DATA_LENGTH) {
			throw failure('append', input.path, oversizedBatchReason(data.length, input.records));
		}
		const result = await this.runner.transaction(async (tx) => {
			const streams = tx.collection(collectionName(this.prefix, 'conversation_streams'));
			const meta = await streams.findOne({ _id: input.path });
			if (!meta) throw failure('append', input.path, 'Stream does not exist.');
			if (
				meta.producerId !== input.producerId ||
				Number(meta.producerEpoch) !== input.producerEpoch ||
				meta.incarnation !== input.incarnation
			)
				throw failure('append', input.path, 'Producer ownership is stale.');
			const batches = tx.collection(collectionName(this.prefix, 'conversation_batches'));
			const retry = await batches.findOne({
				path: input.path,
				producerId: input.producerId,
				producerEpoch: input.producerEpoch,
				producerSequence: input.producerSequence,
			});
			if (retry) {
				if (
					retry.data !== data ||
					(retry.submissionId ?? null) !== (input.submission?.submissionId ?? null) ||
					(retry.attemptId ?? null) !== (input.submission?.attemptId ?? null)
				)
					throw failure('append', input.path, 'Producer sequence has conflicting content.');
				return { offset: formatOffset(Number(retry.offset)), appended: false };
			}
			if (Number(meta.nextProducerSequence) !== input.producerSequence)
				throw failure('append', input.path, 'Producer sequence is not the next expected value.');
			await assertSubmissionAuthorization(
				tx,
				this.prefix,
				input.path,
				meta.identity as ConversationStreamIdentity,
				input.submission,
				input.records,
			);
			const offset = Number(meta.nextOffset);
			await batches.insertOne({
				_id: `${input.path}:${offset}`,
				path: input.path,
				offset,
				producerId: input.producerId,
				producerEpoch: input.producerEpoch,
				producerSequence: input.producerSequence,
				data,
				submissionId: input.submission?.submissionId ?? null,
				attemptId: input.submission?.attemptId ?? null,
			});
			const updated = await streams.updateOne(
				{
					_id: input.path,
					producerId: input.producerId,
					producerEpoch: input.producerEpoch,
					incarnation: input.incarnation,
					nextOffset: offset,
					nextProducerSequence: input.producerSequence,
				},
				{ $inc: { nextOffset: 1, nextProducerSequence: 1 } },
			);
			if (updated.modifiedCount !== 1)
				throw failure('append', input.path, 'Producer ownership changed during append.');
			return { offset: formatOffset(offset), appended: true };
		});
		if (result.appended) this.listeners.notify(input.path);
		return { offset: result.offset };
	}

	async read(
		path: string,
		options?: { offset?: string; limit?: number },
	): Promise<ConversationStreamReadResult> {
		const meta = await this.getMeta(path);
		if (!meta) return { batches: [], nextOffset: '-1', upToDate: true };
		const rawOffset = options?.offset ?? '-1';
		if (rawOffset === 'now') return { batches: [], nextOffset: meta.nextOffset, upToDate: true };
		const start = parseOffset(rawOffset);
		if (!Number.isSafeInteger(start) || start > parseOffset(meta.nextOffset))
			throw failure('read', path, 'Read offset is beyond the canonical stream head.');
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const rows = await this.batches().find(
			{ path, offset: { $gt: start } },
			{ sort: { offset: 1 }, limit: limit + 1 },
		);
		const page = rows.slice(0, limit);
		const batches = page.map((row) => ({
			offset: formatOffset(Number(row.offset)),
			records: JSON.parse(String(row.data)) as ConversationRecord[],
		}));
		return {
			batches,
			nextOffset: batches.at(-1)?.offset ?? formatOffset(start),
			upToDate: rows.length <= limit,
		};
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const row = await this.streams().findOne({ _id: path });
		if (!row) return null;
		return {
			identity: row.identity as ConversationStreamIdentity,
			incarnation: String(row.incarnation),
			nextOffset: formatOffset(Number(row.nextOffset) - 1),
			producerId: row.producerId == null ? null : String(row.producerId),
			producerEpoch: Number(row.producerEpoch),
			nextProducerSequence: Number(row.nextProducerSequence),
		};
	}

	subscribe(path: string, listener: () => void): () => void {
		return this.listeners.subscribe(path, listener);
	}

	private streams() {
		return this.runner.collection(collectionName(this.prefix, 'conversation_streams'));
	}
	private batches() {
		return this.runner.collection(collectionName(this.prefix, 'conversation_batches'));
	}
}

async function assertSubmissionAuthorization(
	tx: MongoOperations,
	prefix: string,
	path: string,
	identity: ConversationStreamIdentity,
	submission: { submissionId: string; attemptId: string } | undefined,
	records: readonly ConversationRecord[],
): Promise<void> {
	const owned = records.filter(
		(record) => record.submissionId !== undefined || record.attemptId !== undefined,
	);
	if (!submission) {
		if (owned.length > 0)
			throw failure('append', path, 'Submission-owned records require attempt authorization.');
		return;
	}
	const submissions = tx.collection(collectionName(prefix, 'submissions'));
	for (const record of owned) {
		if (
			record.submissionId === submission.submissionId &&
			record.attemptId === submission.attemptId
		)
			continue;
		// Turn-boundary join: the host attempt writes a joined delivery's input
		// and adoption records under its own authority. Legal exactly when the
		// delivery's row is durably claimed by THIS host (`joining`/`joined`
		// with `joinedInto` = the authorized submission) and the record still
		// carries the host's attempt.
		if (record.attemptId === submission.attemptId && record.submissionId !== undefined) {
			const delivery = await submissions.findOne({ submissionId: record.submissionId });
			if (
				(delivery?.status === 'joining' || delivery?.status === 'joined') &&
				delivery.joinedInto === submission.submissionId
			) {
				continue;
			}
		}
		throw failure(
			'append',
			path,
			'Record ownership does not match the authorized submission attempt.',
		);
	}
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
	const sessionIdentity =
		typeof row?.sessionKey === 'string' ? parseSessionStorageKey(row.sessionKey) : undefined;
	if (
		!row ||
		(row.status !== 'running' && !terminalizingSettlement) ||
		!sessionIdentity ||
		sessionIdentity.agentName !== identity.agentName ||
		sessionIdentity.instanceId !== identity.instanceId
	) {
		throw failure(
			'append',
			path,
			'Submission attempt no longer owns work for this agent instance.',
		);
	}
	const ownership = terminalizingSettlement
		? {
				status: 'terminalizing',
				settlementRecordId: owned[0]?.id,
				settlementRecord: row.settlementRecord,
			}
		: { status: 'running' };
	const fenced = await submissions.updateOne(
		{ _id: row._id, attemptId: submission.attemptId, ...ownership },
		{ $inc: { conversationWriteRevision: 1 } },
	);
	if (fenced.modifiedCount !== 1) {
		throw failure('append', path, 'Submission attempt ownership changed during append.');
	}
}

function isDuplicateKeyError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 11000;
}

function failure(operation: string, path: string, reason: string): ConversationStreamStoreError {
	return new ConversationStreamStoreError({ operation, path, reason });
}

/**
 * Ceiling on one serialized batch, well under MongoDB's 16MB document cap and
 * generous by an order of magnitude: a 2MB record already approximates 200k
 * tokens against a 1M-token maximum context window, so a batch past 12MB
 * indicates an unbounded tool result or message rather than real conversation
 * data.
 */
const MAX_BATCH_DATA_LENGTH = 12 * 1024 * 1024;

// The same per-append ceiling guards @flue/runtime's Durable Object SQLite
// store (conversation-stream-store.ts) and shared async SQL store.
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
