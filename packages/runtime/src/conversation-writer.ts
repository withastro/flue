import {
	type AbandonedMessageAuthorization,
	abandonedMessageRecordId,
	checkAbandonedMessageRows,
	parseAbandonedMessageBatch,
} from './abandoned-message.ts';
import type { AgentSubmissionStore, SubmissionAttemptRef } from './agent-execution-store.ts';
import { FOLD_CHECKPOINT_INTERVAL, writeFoldCheckpoint } from './conversation-fold-checkpoint.ts';
import { type ConversationFoldHost, getConversationFoldHost } from './conversation-fold-host.ts';
import type {
	CanonicalChildSessionRef,
	ConversationCreatedRecord,
	ConversationRecord,
} from './conversation-records.ts';
import type { IndexedConversationRecord, ReducedInstanceState } from './conversation-reducer.ts';
import { conversationScopeKey, reduceConversationRecords } from './conversation-reducer.ts';
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
	abandonedMessage?: AbandonedMessageAuthorization;
}

type ConversationCreationInput = ConversationCreatedRecord extends infer Record
	? Record extends ConversationCreatedRecord
		? Omit<Record, 'v' | 'id' | 'type' | 'timestamp'>
		: never
	: never;

type WriterLifecycle = { status: 'active' } | { status: 'failed'; error: unknown };

/**
 * How long streamed deltas are coalesced before being appended to the durable
 * stream. The timer only governs mid-block streaming cadence — block boundaries
 * and message completion flush immediately. Lower = smoother live streaming
 * (deltas reach observers sooner, in smaller batches) at the cost of more
 * durable writes; higher = fewer writes but burstier streaming.
 */
const CANONICAL_FLUSH_DELAY_MS = 1000;

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

	private readonly foldHost: ConversationFoldHost;
	private batchesSinceFoldCheckpoint = 0;

	private constructor(
		private readonly store: ConversationStreamStore,
		readonly path: string,
		private claim: ConversationProducerClaim,
		private readonly streamIdentity: ConversationStreamIdentity,
		private readonly onFailed?: (writer: ConversationRecordWriter) => void,
	) {
		this.nextProducerSequence = claim.nextProducerSequence;
		this.foldHost = getConversationFoldHost(store, path);
		this.foldHost.pin();
	}

	static async create(options: {
		store: ConversationStreamStore;
		path: string;
		identity: ConversationStreamIdentity;
		producerId: string;
		onFailed?: (writer: ConversationRecordWriter) => void;
	}): Promise<ConversationRecordWriter> {
		await options.store.createStream(options.path, options.identity);
		const claim = await options.store.acquireProducer(options.path, options.producerId);
		return new ConversationRecordWriter(
			options.store,
			options.path,
			claim,
			options.identity,
			options.onFailed,
		);
	}

	async loadReducedState(): Promise<ReducedInstanceState> {
		this.assertActive();
		if (this.reducedState) return this.reducedState;
		// The shared fold host serves the same state a from-scratch load
		// produces — and reuses a fold a read already paid for. The producer
		// fence guarantees no other writer can append behind this claim, so
		// the host's head is this writer's head.
		const sequenceBefore = this.nextProducerSequence;
		const loaded = await this.foldHost.getStateAtHead();
		this.assertActive();
		// A first append racing this load would make the loaded state stale —
		// and, once memoized, every later append would fold onto it and publish
		// the gap to the shared host. No live path appends before loading;
		// re-loading keeps the host safe if one ever does.
		if (this.nextProducerSequence !== sequenceBefore) return this.loadReducedState();
		this.reducedState ??= loaded;
		return this.reducedState;
	}

	async getConversationLeaf(conversationId: string): Promise<string | null> {
		return (await this.loadReducedState()).conversations.get(conversationId)?.activeLeafId ?? null;
	}

	async hasConversationEntry(conversationId: string, entryId: string): Promise<boolean> {
		return (
			(await this.loadReducedState()).conversations.get(conversationId)?.entries.has(entryId) ??
			false
		);
	}

	async hasRecord(recordId: string): Promise<boolean> {
		return (await this.loadReducedState()).recordsById.has(recordId);
	}

	async getRecord(recordId: string): Promise<IndexedConversationRecord | undefined> {
		return (await this.loadReducedState()).recordsById.get(recordId);
	}

	async getConversation(conversationId: string) {
		return (await this.loadReducedState()).conversations.get(conversationId);
	}

	async findConversation(harness: string, session: string) {
		const state = await this.loadReducedState();
		const conversationId = state.conversationScopes.get(conversationScopeKey(harness, session));
		return conversationId ? state.conversations.get(conversationId) : undefined;
	}

	get offset(): string {
		return this.reducedState?.recordsThroughOffset ?? this.claim.offset;
	}

	get failed(): boolean {
		return this.lifecycle.status === 'failed';
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
			if (
				this.pendingRecords.length > 0 &&
				!sameAppendOptions(this.pendingOptions ?? {}, options)
			) {
				throw new Error(
					'[flue] Canonical batch ownership changed before the pending batch flushed.',
				);
			}
			this.pendingOptions = options;
			this.pendingRecords.push(...records);
			this.pendingFlush ??= new Promise<{ offset: string }>((resolve, reject) => {
				this.resolvePending = resolve;
				this.rejectPending = reject;
			});
			this.pendingTimer ??= setTimeout(() => {
				void this.flush().catch(() => {});
			}, CANONICAL_FLUSH_DELAY_MS);
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
				return Promise.resolve({
					offset: this.reducedState?.recordsThroughOffset ?? this.claim.offset,
				});
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

	/** Clear only old terminal dispatch messages before this attempt appends its input. */
	async clearAbandonedMessages(
		submissions: Pick<AgentSubmissionStore, 'getSubmission'>,
		before: SubmissionAttemptRef,
	): Promise<void> {
		await this.flush();
		return this.serialize(async () => {
			const state = await this.loadReducedState();
			const conversation = [...state.conversations.values()].find(
				(value) => value.harness === 'default' && value.session === 'default',
			);
			if (!conversation) return;
			const candidates = [...conversation.inProgressMessages.values()].filter(
				(message) => message.parentId !== conversation.activeLeafId,
			);
			if (candidates.length === 0) return;
			if (!this.store.supportsAbandonedMessageCleanup) {
				throw new Error(
					'[flue] Abandoned message cleanup requires transactional submission storage.',
				);
			}
			const next = await submissions.getSubmission(before.submissionId);
			for (const message of candidates) {
				if (!message.submissionId)
					throw new Error('[flue] Abandoned message has no stored submission.');
				const old = await submissions.getSubmission(message.submissionId);
				const record: ConversationRecord = {
					v: 2,
					id: abandonedMessageRecordId(
						conversation.conversationId,
						message.submissionId,
						message.messageId,
					),
					type: 'assistant_message_abandoned',
					conversationId: conversation.conversationId,
					harness: 'default',
					session: 'default',
					timestamp: new Date().toISOString(),
					submissionId: message.submissionId,
					messageId: message.messageId,
				};
				const parsed = parseAbandonedMessageBatch(
					[record],
					{
						before,
						target: {
							submissionId: old?.submissionId,
							sessionKey: old?.sessionKey,
							sequence: old?.sequence,
							settledAt: old?.settledAt,
						},
					},
					undefined,
				);
				if (!parsed.ok) throw new Error(`[flue] ${parsed.reason}`);
				if (!parsed.value) throw new Error('[flue] Cleanup record is missing.');
				const checked = checkAbandonedMessageRows(
					parsed.value.authorization,
					old,
					next,
					this.streamIdentity,
				);
				if (!checked.ok) throw new Error(`[flue] ${checked.reason}`);
				// Enqueues do not take the writer queue. Refuse if a producer buffers more work during the read.
				if (this.pendingRecords.length > 0) {
					throw new Error(
						'[flue] Pending conversation writes must finish before abandoned message cleanup.',
					);
				}
				await this.appendNow([parsed.value.record], {
					abandonedMessage: parsed.value.authorization,
				});
			}
		});
	}

	private serialize<T>(work: () => Promise<T>): Promise<T> {
		const operation = this.tail.then(work);
		this.tail = operation.then(
			() => {},
			() => {},
		);
		return operation;
	}

	private appendBatch(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions,
	): Promise<{ offset: string }> {
		return this.serialize(() => this.appendNow(records, options));
	}

	private async appendNow(
		records: readonly ConversationRecord[],
		options: ConversationAppendOptions,
	): Promise<{ offset: string }> {
		this.assertActive();
		const reduced = this.reducedState
			? reduceConversationRecords(
					this.reducedState,
					records,
					this.reducedState.recordsThroughOffset,
				)
			: undefined;
		const producerSequence = this.nextProducerSequence;
		const input = {
			path: this.path,
			producerId: this.claim.producerId,
			producerEpoch: this.claim.producerEpoch,
			incarnation: this.claim.incarnation,
			producerSequence,
			...(options.submission ? { submission: options.submission } : {}),
			...(options.abandonedMessage ? { abandonedMessage: options.abandonedMessage } : {}),
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
				this.foldHost.adoptState(reduced, this.claim.incarnation);
				// Durable fold checkpoint. The encode is synchronous (states
				// are never mutated after publication, so it reads a stable
				// snapshot); the store write floats off the append's critical
				// path — the batch is durable either way, and a lost
				// checkpoint just means the next cold load folds a longer
				// suffix.
				this.batchesSinceFoldCheckpoint += 1;
				if (this.batchesSinceFoldCheckpoint >= FOLD_CHECKPOINT_INTERVAL) {
					this.batchesSinceFoldCheckpoint = 0;
					writeFoldCheckpoint(this.store, this.path, reduced, this.claim.incarnation);
				}
			}
			return result;
		} catch (error) {
			throw this.fail(error);
		}
	}

	private assertActive(): void {
		if (this.lifecycle.status === 'failed') throw this.lifecycle.error;
	}

	private fail(error: unknown): unknown {
		if (this.lifecycle.status === 'failed') return this.lifecycle.error;
		this.lifecycle = { status: 'failed', error };
		this.foldHost.unpin();
		this.onFailed?.(this);
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
		if (
			!parent ||
			parent.harness !== input.parent.harness ||
			parent.session !== input.parent.session
		) {
			throw new Error('[flue] Canonical child parent is missing or conflicts with its scope.');
		}
		const existing = state.conversations.get(input.child.conversationId);
		const retained = parent.childConversations.get(input.child.conversationId);
		if (existing || retained) {
			if (
				!existing ||
				!retained ||
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
							...(input.child.agent ? { agent: input.child.agent } : {}),
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

	async ensureConversation(
		input: ConversationCreationInput & {
			timestamp?: string;
		},
	): Promise<{ offset: string }> {
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
				throw new Error(
					'[flue] Canonical conversation identity conflicts with the requested session.',
				);
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

function sameAppendOptions(
	left: ConversationAppendOptions,
	right: ConversationAppendOptions,
): boolean {
	return (
		left.submission?.submissionId === right.submission?.submissionId &&
		left.submission?.attemptId === right.submission?.attemptId &&
		JSON.stringify(left.abandonedMessage) === JSON.stringify(right.abandonedMessage)
	);
}
