import {
	loadReducedConversationState,
} from './conversation-reader.ts';
import type {
	CanonicalChildSessionRef,
	ConversationCreatedRecord,
	ConversationRecord,
} from './conversation-records.ts';
import type { ReducedInstanceState } from './conversation-reducer.ts';
import { reduceConversationRecords } from './conversation-reducer.ts';
import type {
	ConversationProducerClaim,
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

type ConversationCreationInput = ConversationCreatedRecord extends infer Record
	? Record extends ConversationCreatedRecord
		? Omit<Record, 'v' | 'id' | 'type' | 'timestamp'>
		: never
	: never;

type WriterLifecycle =
	| { status: 'active' }
	| { status: 'failed'; error: unknown };

export class ConversationRecordWriter {
	private lifecycle: WriterLifecycle = { status: 'active' };
	private tail: Promise<void> = Promise.resolve();
	private nextProducerSequence: number;
	private reducedState: ReducedInstanceState | undefined;
	private pendingRecords: ConversationRecord[] = [];
	private pendingOptions: ConversationAppendOptions | undefined;
	private pendingTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingFlush: Promise<{ offset: string }> | undefined;
	private flushing: Promise<{ offset: string }> | undefined;
	private resolvePending: ((result: { offset: string }) => void) | undefined;
	private rejectPending: ((error: unknown) => void) | undefined;

	private constructor(
		private readonly store: ConversationStreamStore,
		readonly path: string,
		private claim: ConversationProducerClaim,
	) {
		this.nextProducerSequence = claim.nextProducerSequence;
	}

	static async create(options: {
		store: ConversationStreamStore;
		path: string;
		identity: ConversationStreamIdentity;
		producerId: string;
	}): Promise<ConversationRecordWriter> {
		await options.store.createStream(options.path, options.identity);
		const claim = await options.store.acquireProducer(options.path, options.producerId);
		return new ConversationRecordWriter(options.store, options.path, claim);
	}

	async loadReducedState(): Promise<ReducedInstanceState> {
		this.assertActive();
		this.reducedState ??= await loadReducedConversationState({
			store: this.store,
			path: this.path,
		});
		this.assertActive();
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
			(conversation) => conversation.harness === harness && conversation.session === session,
		);
		if (matches.length > 1) throw new Error('[flue] Multiple active canonical conversations share one session scope.');
		return matches[0];
	}

	get offset(): string {
		return this.reducedState?.recordsThroughOffset ?? this.claim.offset;
	}

	append(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions = {},
	): Promise<{ offset: string }> {
		try {
			this.assertActive();
			return this.appendBatch(records, options);
		} catch (error) {
			return Promise.reject(error);
		}
	}

	enqueue(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions = {},
	): Promise<{ offset: string }> {
		try {
			this.assertActive();
			if (this.pendingRecords.length > 0 && !sameAppendOptions(this.pendingOptions ?? {}, options)) {
				throw new Error('[flue] Canonical batch ownership changed before the pending batch flushed.');
			}
			this.pendingOptions = options;
			this.pendingRecords.push(...records);
			this.pendingFlush ??= new Promise<{ offset: string }>((resolve, reject) => {
				this.resolvePending = resolve;
				this.rejectPending = reject;
			});
			this.pendingTimer ??= setTimeout(() => {
				void this.flush().catch(() => {});
			}, 3000);
			return this.pendingFlush;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	flush(): Promise<{ offset: string }> {
		try {
			this.assertActive();
			if (this.flushing) {
				if (this.pendingRecords.length === 0) return this.flushing;
				return this.flushing.then(() => this.flush());
			}
			if (this.pendingTimer) clearTimeout(this.pendingTimer);
			this.pendingTimer = undefined;
			if (this.pendingRecords.length === 0) {
				return Promise.resolve({ offset: this.reducedState?.recordsThroughOffset ?? this.claim.offset });
			}
			const records = this.pendingRecords;
			const options = this.pendingOptions ?? {};
			const resolve = this.resolvePending;
			const reject = this.rejectPending;
			this.pendingRecords = [];
			this.pendingOptions = undefined;
			this.pendingFlush = undefined;
			this.resolvePending = undefined;
			this.rejectPending = undefined;
			const operation = this.appendBatch(records, options).then(
				(result) => {
					resolve?.(result);
					return result;
				},
				(error) => {
					reject?.(error);
					throw error;
				},
			);
			this.flushing = operation;
			void operation.then(
				() => {
					if (this.flushing === operation) this.flushing = undefined;
				},
				() => {},
			);
			return operation;
		} catch (error) {
			return Promise.reject(error);
		}
	}

	private appendBatch(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions,
	): Promise<{ offset: string }> {
		const operation = this.tail.then(async () => {
			this.assertActive();
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
				let result: { offset: string };
				try {
					result = await this.store.append(input);
				} catch (firstError) {
					try {
						result = await this.store.append(input);
					} catch {
						throw firstError;
					}
				}
				this.nextProducerSequence = producerSequence + 1;
				if (reduced) {
					reduced.recordsThroughOffset = result.offset;
					this.reducedState = reduced;
				}
				return result;
			} catch (error) {
				throw this.fail(error);
			}
		});
		this.tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private assertActive(): void {
		if (this.lifecycle.status === 'failed') throw this.lifecycle.error;
	}

	private fail(error: unknown): unknown {
		if (this.lifecycle.status === 'failed') return this.lifecycle.error;
		this.lifecycle = { status: 'failed', error };
		if (this.pendingTimer) clearTimeout(this.pendingTimer);
		this.pendingTimer = undefined;
		this.pendingRecords = [];
		this.pendingOptions = undefined;
		const reject = this.rejectPending;
		this.pendingFlush = undefined;
		this.resolvePending = undefined;
		this.rejectPending = undefined;
		reject?.(error);
		return error;
	}

	async ensureChildConversation(input: {
		parent: ConversationRecordScope;
		child: Exclude<ConversationCreationInput, { kind: 'root' }>;
		ref: CanonicalChildSessionRef;
	}): Promise<{ offset: string }> {
		const state = await this.loadReducedState();
		const parent = state.conversations.get(input.parent.conversationId);
		if (!parent || parent.harness !== input.parent.harness || parent.session !== input.parent.session) {
			throw new Error('[flue] Canonical child parent is missing or conflicts with its scope.');
		}
		const existing = state.conversations.get(input.child.conversationId);
		const retained = parent.childConversations.get(input.child.conversationId);
		if (existing || retained) {
			if (
				!existing || !retained ||
				existing.harness !== input.child.harness ||
				existing.session !== input.child.session ||
				existing.affinityKey !== input.child.affinityKey ||
				existing.parentConversationId !== input.parent.conversationId ||
				JSON.stringify(retained) !== JSON.stringify(input.ref)
			) {
				throw new Error('[flue] Canonical child conversation conflicts with retained topology.');
			}
			return { offset: state.recordsThroughOffset };
		}
		const timestamp = input.child.createdAt;
		return this.append([
			{
				v: 1,
				id: `record_conversation_created_${input.child.conversationId}`,
				type: 'conversation_created',
				conversationId: input.child.conversationId,
				harness: input.child.harness,
				session: input.child.session,
				timestamp,
				affinityKey: input.child.affinityKey,
				createdAt: input.child.createdAt,
				...(input.child.kind === 'task'
					? {
							kind: 'task' as const,
							parentConversationId: input.parent.conversationId,
							taskId: input.child.taskId,
					  }
					: {
							kind: 'action' as const,
							parentConversationId: input.parent.conversationId,
							actionInvocationId: input.child.actionInvocationId,
					  }),
			},
			{
				v: 1,
				id: `record_child_retained_${input.parent.conversationId}_${input.child.conversationId}`,
				type: 'child_session_retained',
				conversationId: input.parent.conversationId,
				harness: input.parent.harness,
				session: input.parent.session,
				timestamp,
				child: input.ref,
			},
		]);
	}

	async ensureConversation(input: ConversationCreationInput & {
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
				...input,
				v: 1,
				id: `record_conversation_created_${input.conversationId}`,
				type: 'conversation_created',
				timestamp,
			},
		]);
	}
}

function sameAppendOptions(left: ConversationAppendOptions, right: ConversationAppendOptions): boolean {
	return left.submission?.submissionId === right.submission?.submissionId &&
		left.submission?.attemptId === right.submission?.attemptId;
}
