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
import {
	acquireConversationProducerScript,
	appendConversationScript,
	closeConversationScript,
	createConversationScript,
	deleteConversationScript,
	readConversationScript,
} from './conversation-scripts.ts';
import type { RedisKeys } from './redis-keys.ts';
import type { RedisRunner } from './redis-runner.ts';

function strings(value: unknown): string[] {
	return Array.isArray(value) ? value.map(String) : [];
}

function integer(value: string | undefined): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new TypeError('Persisted Redis integer is malformed.');
	return parsed;
}

export class RedisConversationStreamStore implements ConversationStreamStore {
	private listeners = new Map<string, Set<() => void>>();

	constructor(private runner: RedisRunner, private keys: RedisKeys) {}

	async createStream(path: string, identity: ConversationStreamIdentity): Promise<void> {
		const result = strings(await this.runner.eval(
			createConversationScript,
			[this.keys.conversation(path), this.keys.conversations()],
			[JSON.stringify(identity), crypto.randomUUID(), path],
		));
		if (result[0] === 'conflict') throw failure('create', path, 'Stream identity conflicts.');
	}

	async acquireProducer(path: string, producerId: string) {
		const result = strings(await this.runner.eval(
			acquireConversationProducerScript,
			[this.keys.conversation(path)],
			[producerId],
		));
		if (result[0] !== 'acquired') throw failure('acquire_producer', path, result[0] === 'closed' ? 'Stream is closed.' : 'Stream does not exist.');
		return {
			producerId,
			producerEpoch: integer(result[1]),
			incarnation: result[3] ?? '',
			nextProducerSequence: 0,
			offset: formatOffset(integer(result[2]) - 1),
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
		if (input.records.length === 0) throw failure('append', input.path, 'A canonical batch cannot be empty.');
		const owned = input.records.filter((record) => record.submissionId !== undefined || record.attemptId !== undefined);
		if (!input.submission && owned.length > 0) throw failure('append', input.path, 'Submission-owned records require attempt authorization.');
		if (input.submission && owned.some((record) => record.submissionId !== input.submission?.submissionId || record.attemptId !== input.submission?.attemptId)) {
			throw failure('append', input.path, 'Record ownership does not match the authorized submission attempt.');
		}
		const meta = await this.getMeta(input.path);
		if (!meta) throw failure('append', input.path, 'Stream does not exist.');
		const first = input.records[0];
		if (!first) throw failure('append', input.path, 'A canonical batch cannot be empty.');
		const expectedInstanceId = meta.identity.instanceId;
		const expectedHead = input.expectedOffset === undefined ? '' : String(parseOffset(input.expectedOffset));
		const submissionKey = input.submission ? this.keys.submission(input.submission.submissionId) : this.keys.meta();
		const result = strings(await this.runner.eval(
			appendConversationScript,
			[
				this.keys.conversation(input.path),
				this.keys.conversationBatches(input.path),
				this.keys.conversationOrder(input.path),
				this.keys.conversationRetries(input.path),
				submissionKey,
			],
			[
				input.producerId,
				input.producerEpoch,
				input.incarnation,
				input.producerSequence,
				JSON.stringify(input.records),
				input.submission?.submissionId ?? '',
				input.submission?.attemptId ?? '',
				expectedHead,
				expectedInstanceId,
			],
		));
		if (result[0] !== 'appended' && result[0] !== 'retry') {
			throw failure('append', input.path, appendReason(result[0]));
		}
		if (result[0] === 'appended') this.notify(input.path);
		return { offset: formatOffset(integer(result[1])) };
	}

	async read(path: string, options?: { offset?: string; limit?: number }): Promise<ConversationStreamReadResult> {
		const meta = await this.getMeta(path);
		if (!meta) return { batches: [], nextOffset: '-1', upToDate: true, closed: false };
		const raw = options?.offset ?? '-1';
		if (raw === 'now') return { batches: [], nextOffset: meta.nextOffset, upToDate: true, closed: meta.closed };
		const start = parseOffset(raw);
		const limit = clampLimit(options?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const result = strings(await this.runner.eval(
			readConversationScript,
			[
				this.keys.conversation(path),
				this.keys.conversationOrder(path),
				this.keys.conversationBatches(path),
			],
			[start, limit],
		));
		if (result[0] === 'missing') return { batches: [], nextOffset: '-1', upToDate: true, closed: false };
		if (result[0] === 'offset') throw failure('read', path, 'Read offset is beyond the canonical stream head.');
		if (result[0] !== 'read') throw failure('read', path, 'Persisted canonical batch is malformed.');
		const payload = result.slice(4);
		const batches = [];
		for (let index = 0; index < Math.min(payload.length, limit * 2); index += 2) {
			const sequence = payload[index];
			const data = payload[index + 1];
			if (sequence === undefined || data === undefined) throw failure('read', path, 'Persisted canonical batch is malformed.');
			batches.push({ offset: formatOffset(integer(sequence)), records: JSON.parse(data) as ConversationRecord[] });
		}
		return {
			batches,
			nextOffset: batches.at(-1)?.offset ?? formatOffset(start),
			upToDate: payload.length / 2 <= limit,
			closed: result[2] === '1',
		};
	}

	async getMeta(path: string): Promise<ConversationStreamMeta | null> {
		const value = await this.runner.command('HGETALL', [this.keys.conversation(path)]);
		const entries = strings(value);
		if (entries.length === 0) return null;
		const row = Object.fromEntries(Array.from({ length: entries.length / 2 }, (_, index) => [entries[index * 2], entries[index * 2 + 1]]));
		return {
			identity: JSON.parse(row.identity ?? 'null') as ConversationStreamIdentity,
			incarnation: row.incarnation ?? '',
			nextOffset: formatOffset(integer(row.nextOffset) - 1),
			closed: row.closed === '1',
			producerId: row.producerId ?? null,
			producerEpoch: integer(row.producerEpoch),
			nextProducerSequence: integer(row.nextProducerSequence),
		};
	}

	async close(path: string): Promise<void> {
		await this.runner.eval(closeConversationScript, [this.keys.conversation(path)]);
		this.notify(path);
	}

	async delete(path: string): Promise<void> {
		await this.runner.eval(
			deleteConversationScript,
			[
				this.keys.conversation(path),
				this.keys.conversationBatches(path),
				this.keys.conversationOrder(path),
				this.keys.conversationRetries(path),
				this.keys.conversations(),
			],
			[path],
		);
		this.notify(path);
	}

	subscribe(path: string, listener: () => void): () => void {
		const listeners = this.listeners.get(path) ?? new Set();
		listeners.add(listener);
		this.listeners.set(path, listeners);
		return () => { listeners.delete(listener); if (listeners.size === 0) this.listeners.delete(path); };
	}

	private notify(path: string): void { for (const listener of this.listeners.get(path) ?? []) { try { listener(); } catch {} } }
}

function appendReason(code: string | undefined): string {
	if (code === 'missing') return 'Stream does not exist.';
	if (code === 'closed') return 'Stream is closed.';
	if (code === 'stale') return 'Producer ownership is stale.';
	if (code === 'conflict') return 'Producer sequence has conflicting content.';
	if (code === 'sequence') return 'Producer sequence is not the next expected value.';
	if (code === 'head') return 'Expected stream head does not match the current head.';
	if (code === 'attempt') return 'Submission attempt no longer owns work for this session.';
	return 'Canonical append failed.';
}

function failure(operation: string, path: string, reason: string): ConversationStreamStoreError {
	return new ConversationStreamStoreError({ operation, path, reason });
}
