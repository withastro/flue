import {
	CONVERSATION_REDUCER_VERSION,
	CONVERSATION_SNAPSHOT_VERSION,
	encodeReducedInstanceState,
	loadReducedConversationState,
} from './conversation-reader.ts';
import type { ConversationCreatedRecord, ConversationRecord } from './conversation-records.ts';
import type { ReducedInstanceState } from './conversation-reducer.ts';
import { reduceConversationRecords } from './conversation-reducer.ts';
import type {
	ConversationProducerClaim,
	ConversationSnapshotStore,
	ConversationStreamIdentity,
	ConversationStreamStore,
} from './runtime/conversation-stream-store.ts';

export interface ConversationRecordScope {
	conversationId: string;
	harness: string;
	session: string;
}

export interface ConversationAppendOptions {
	submission?: { submissionId: string; attemptId: string };
}

export class ConversationRecordWriter {
	private tail: Promise<void> = Promise.resolve();
	private nextProducerSequence: number;
	private reducedState: ReducedInstanceState | undefined;
	private pendingRecords: ConversationRecord[] = [];
	private pendingOptions: ConversationAppendOptions | undefined;
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingFlush: Promise<{ offset: string }> | undefined;
	private resolvePending: ((result: { offset: string }) => void) | undefined;
	private rejectPending: ((error: unknown) => void) | undefined;

	private constructor(
		private readonly store: ConversationStreamStore,
		private readonly snapshots: ConversationSnapshotStore | undefined,
		readonly path: string,
		private readonly claim: ConversationProducerClaim,
	) {
		this.nextProducerSequence = claim.nextProducerSequence;
	}

	static async create(options: {
		store: ConversationStreamStore;
		path: string;
		identity: ConversationStreamIdentity;
		producerId: string;
		snapshots?: ConversationSnapshotStore;
	}): Promise<ConversationRecordWriter> {
		await options.store.createStream(options.path, options.identity);
		const claim = await options.store.acquireProducer(options.path, options.producerId);
		return new ConversationRecordWriter(options.store, options.snapshots, options.path, claim);
	}

	async loadReducedState(): Promise<ReducedInstanceState> {
		this.reducedState ??= await loadReducedConversationState({
			store: this.store,
			path: this.path,
			snapshots: this.snapshots,
			streamIncarnation: this.claim.incarnation,
		});
		return this.reducedState;
	}

	async getConversationLeaf(conversationId: string): Promise<string | null> {
		return (await this.loadReducedState()).conversations.get(conversationId)?.activeLeafId ?? null;
	}

	async hasConversationEntry(conversationId: string, entryId: string): Promise<boolean> {
		return (await this.loadReducedState()).conversations.get(conversationId)?.entries.has(entryId) ?? false;
	}

	async hasRecord(recordId: string): Promise<boolean> {
		return (await this.loadReducedState()).recordsById.has(recordId);
	}

	async getRecord(recordId: string): Promise<import('./conversation-records.ts').ConversationRecord | undefined> {
		return (await this.loadReducedState()).recordsById.get(recordId);
	}

	async getConversation(conversationId: string) {
		return (await this.loadReducedState()).conversations.get(conversationId);
	}

	async findInProgressAssistant(conversationId: string, submissionId: string) {
		const conversation = await this.getConversation(conversationId);
		return [...(conversation?.inProgressMessages.values() ?? [])].find(
			(message) => message.submissionId === submissionId,
		);
	}

	async findConversation(harness: string, session: string) {
		const matches = [...(await this.loadReducedState()).conversations.values()].filter(
			(conversation) => conversation.harness === harness && conversation.session === session && !conversation.deleted,
		);
		if (matches.length > 1) throw new Error('[flue] Multiple active canonical conversations share one session scope.');
		return matches[0];
	}

	async saveSnapshot(): Promise<void> {
		if (!this.snapshots || !this.reducedState) return;
		await this.snapshots.save(this.path, {
			version: CONVERSATION_SNAPSHOT_VERSION,
			reducerVersion: CONVERSATION_REDUCER_VERSION,
			streamOffset: this.reducedState.recordsThroughOffset,
			streamIncarnation: this.claim.incarnation,
			state: encodeReducedInstanceState(this.reducedState),
			createdAt: new Date().toISOString(),
		});
	}

	get offset(): string {
		return this.reducedState?.recordsThroughOffset ?? this.claim.offset;
	}

	append(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions = {},
	): Promise<{ offset: string }> {
		return this.appendBatch(records, options);
	}

	enqueue(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions = {},
	): Promise<{ offset: string }> {
		if (this.pendingRecords.length > 0 && !sameAppendOptions(this.pendingOptions ?? {}, options)) {
			throw new Error('[flue] Canonical batch ownership changed before the pending batch flushed.');
		}
		this.pendingOptions = options;
		this.pendingRecords.push(...records);
		this.pendingFlush ??= new Promise<{ offset: string }>((resolve, reject) => {
			this.resolvePending = resolve;
			this.rejectPending = reject;
		});
		this.pendingTimer ??= setTimeout(() => void this.flush(), 3000);
		return this.pendingFlush;
	}

	async flush(): Promise<{ offset: string }> {
		if (this.pendingTimer) clearTimeout(this.pendingTimer);
		this.pendingTimer = undefined;
		if (this.pendingRecords.length === 0) return { offset: this.reducedState?.recordsThroughOffset ?? this.claim.offset };
		const records = this.pendingRecords;
		const options = this.pendingOptions ?? {};
		const resolve = this.resolvePending;
		const reject = this.rejectPending;
		this.pendingRecords = [];
		this.pendingOptions = undefined;
		this.pendingFlush = undefined;
		this.resolvePending = undefined;
		this.rejectPending = undefined;
		try {
			const result = await this.appendBatch(records, options);
			resolve?.(result);
			return result;
		} catch (error) {
			reject?.(error);
			throw error;
		}
	}

	private appendBatch(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions,
	): Promise<{ offset: string }> {
		const operation = this.tail.then(async () => {
			const reduced = this.reducedState
				? reduceConversationRecords(this.reducedState, records, this.reducedState.recordsThroughOffset)
				: undefined;
			const producerSequence = this.nextProducerSequence;
			const input = {
				path: this.path,
				producerId: this.claim.producerId,
				producerEpoch: this.claim.producerEpoch,
				incarnation: this.claim.incarnation,
				producerSequence,
				...(options.submission ? { submission: options.submission } : {}),
				records,
			};
			try {
				const result = await this.store.append(input);
				this.nextProducerSequence = producerSequence + 1;
				if (reduced) {
					reduced.recordsThroughOffset = result.offset;
					this.reducedState = reduced;
					void this.saveSnapshot().catch(() => {});
				}
				return result;
			} catch (firstError) {
				try {
					const result = await this.store.append(input);
					this.nextProducerSequence = producerSequence + 1;
					if (reduced) {
						reduced.recordsThroughOffset = result.offset;
						this.reducedState = reduced;
					}
					return result;
				} catch {
					throw firstError;
				}
			}
		});
		this.tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	async ensureConversation(input: Omit<ConversationCreatedRecord, 'v' | 'id' | 'type' | 'timestamp'> & {
		timestamp?: string;
	}): Promise<{ offset: string }> {
		const state = await this.loadReducedState();
		const existing = state.conversations.get(input.conversationId);
		if (existing) {
			if (
				existing.harness !== input.harness ||
				existing.session !== input.session ||
				existing.affinityKey !== input.affinityKey ||
				existing.parentConversationId !== input.parentConversationId ||
				existing.taskId !== input.taskId ||
				existing.actionInvocationId !== input.actionInvocationId
			) {
				throw new Error('[flue] Canonical conversation identity conflicts with the requested session.');
			}
			return { offset: state.recordsThroughOffset };
		}
		const timestamp = input.timestamp ?? input.createdAt;
		return this.append([
			{
				v: 1,
				id: `record_conversation_created_${input.conversationId}`,
				type: 'conversation_created',
				conversationId: input.conversationId,
				harness: input.harness,
				session: input.session,
				timestamp,
				affinityKey: input.affinityKey,
				createdAt: input.createdAt,
				...(input.parentConversationId ? { parentConversationId: input.parentConversationId } : {}),
				...(input.taskId ? { taskId: input.taskId } : {}),
				...(input.actionInvocationId ? { actionInvocationId: input.actionInvocationId } : {}),
			},
		]);
	}
}

function sameAppendOptions(left: ConversationAppendOptions, right: ConversationAppendOptions): boolean {
	return left.submission?.submissionId === right.submission?.submissionId &&
		left.submission?.attemptId === right.submission?.attemptId;
}
