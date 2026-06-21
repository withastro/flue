import { randomUUID } from 'node:crypto';
import type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
	DispatchInput,
	SubmissionAttemptRef,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	deduplicateSessionDeletion,
	hydratePersistedDirectSubmission,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	matchesPersistedDirectSubmission,
	parseAcceptedAt,
	prepareDirectSubmission,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from '@flue/runtime/adapter';
import { publishChunks, stageChunks } from './chunk-store.ts';
import type { MongoDocument, MongoOperations, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';
import { type StoredValue, ValueStore } from './value-store.ts';

const DELETION_LEASE_MS = 30_000;
const DELETION_POLL_MS = 50;

export function deletionOwnershipFilter(
	sessionKey: string,
	ownerId: string,
	fence: number,
	phase: 'callback' | 'cleanup',
): MongoDocument {
	return { _id: sessionKey, ownerId, fence, phase };
}

export class MongoSubmissionStore implements AgentSubmissionStore {
	private pending = new Map<string, Promise<void>>();
	private values: ValueStore;
	constructor(
		private runner: MongoRunner,
		private prefix: string,
	) {
		this.values = new ValueStore(runner, prefix);
	}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = await this.c('submissions').findOne({ submissionId });
		return row ? this.parseSubmission(row) : null;
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const row = await this.c('journals').findOne({ submissionId });
		if (!row) return null;
		const toolRequest = row.toolRequest
			? await this.values.read(row.toolRequest as unknown as StoredValue)
			: undefined;
		return {
			submissionId: String(row.submissionId),
			sessionKey: String(row.sessionKey),
			kind: row.kind as 'dispatch' | 'direct',
			attemptId: String(row.attemptId),
			operationId: String(row.operationId),
			turnId: String(row.turnId),
			phase: row.phase as AgentTurnJournalPhase,
			revision: Number(row.revision),
			createdAt: Number(row.createdAt),
			updatedAt: Number(row.updatedAt),
			...(row.checkpointLeafId ? { checkpointLeafId: String(row.checkpointLeafId) } : {}),
			...(toolRequest !== undefined ? { toolRequest } : {}),
			...(row.streamKey ? { streamKey: String(row.streamKey) } : {}),
			...(row.streamConsumedAt ? { streamConsumedAt: Number(row.streamConsumedAt) } : {}),
			committed: Boolean(row.committed),
			...(row.committedLeafId ? { committedLeafId: String(row.committedLeafId) } : {}),
		};
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return Boolean(await this.c('submissions').findOne({ status: { $in: ['queued', 'running'] } }));
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ status: { $in: ['queued', 'running'] } },
			{ sort: { sequence: 1 } },
		);
		const seen = new Set<string>();
		const output: AgentSubmission[] = [];
		for (const row of rows)
			if (!seen.has(String(row.sessionKey))) {
				seen.add(String(row.sessionKey));
				if (row.status === 'queued') output.push(await this.parseSubmission(row));
			}
		return output;
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find({ status: 'running' }, { sort: { sequence: 1 } });
		const output: AgentSubmission[] = [];
		for (const row of rows) output.push(await this.parseSubmission(row));
		return output;
	}

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const pointer =
			input.toolRequest === undefined
				? undefined
				: await this.values.stage(
						`journal:${input.submissionId}:${randomUUID()}:tool`,
						input.toolRequest,
					);
		const now = Date.now();
		let committed = false;
		try {
			const old = await this.runner.transaction(async (tx) => {
				if (pointer) await this.values.publish(pointer, tx);
				const journals = tx.collection(collectionName(this.prefix, 'journals'));
				const previous = await journals.findOne({ submissionId: input.submissionId });
				await journals.updateOne(
					{ submissionId: input.submissionId },
					{
						$set: {
							_id: input.submissionId,
							submissionId: input.submissionId,
							sessionKey: input.sessionKey,
							kind: input.kind,
							attemptId: input.attemptId,
							operationId: input.operationId,
							turnId: input.turnId,
							phase: input.phase,
							createdAt: previous?.createdAt ?? now,
							updatedAt: now,
							checkpointLeafId: input.checkpointLeafId ?? null,
							toolRequest: pointer ?? null,
							streamKey: null,
							streamConsumedAt: null,
							committed: false,
							committedLeafId: null,
						},
						$inc: { revision: 1 },
					},
					{ upsert: true },
				);
				return previous;
			});
			committed = true;
			if (old?.toolRequest)
				await this.values.retire(old.toolRequest as unknown as StoredValue).catch(() => undefined);
			return true;
		} catch (error) {
			if (!committed && pointer) await this.values.discardStaged(pointer);
			throw error;
		}
	}

	async updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options: { checkpointLeafId?: string; toolRequest?: unknown; streamKey?: string } = {},
	): Promise<boolean> {
		const pointer =
			options.toolRequest === undefined
				? undefined
				: await this.values.stage(
						`journal:${attempt.submissionId}:${randomUUID()}:tool`,
						options.toolRequest,
					);
		const set: MongoDocument = { phase, updatedAt: Date.now() };
		if (options.checkpointLeafId !== undefined) set.checkpointLeafId = options.checkpointLeafId;
		if (options.streamKey !== undefined) set.streamKey = options.streamKey;
		if (pointer) set.toolRequest = pointer;
		let published = false;
		try {
			const outcome = await this.runner.transaction(async (tx) => {
				const journals = tx.collection(collectionName(this.prefix, 'journals'));
				const old = pointer
					? await journals.findOne({
							submissionId: attempt.submissionId,
							attemptId: attempt.attemptId,
							committed: false,
						})
					: null;
				if (pointer) await this.values.publish(pointer, tx);
				const result = await journals.updateOne(
					{ submissionId: attempt.submissionId, attemptId: attempt.attemptId, committed: false },
					{ $set: set, $inc: { revision: 1 } },
				);
				return { old, matched: result.matchedCount === 1 };
			});
			published = outcome.matched;
			if (!outcome.matched && pointer) await this.values.retire(pointer);
			else if (outcome.old?.toolRequest && pointer)
				await this.values
					.retire(outcome.old.toolRequest as unknown as StoredValue)
					.catch(() => undefined);
			return outcome.matched;
		} catch (error) {
			if (!published && pointer) await this.values.discardStaged(pointer);
			throw error;
		}
	}

	async commitTurnJournal(
		attempt: SubmissionAttemptRef,
		committedLeafId: string,
	): Promise<boolean> {
		return this.journalUpdate(attempt, {
			$set: { phase: 'committed', updatedAt: Date.now(), committed: true, committedLeafId },
			$inc: { revision: 1 },
		});
	}
	async markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean> {
		return this.journalUpdate(
			attempt,
			{ $set: { updatedAt: Date.now(), streamConsumedAt: Date.now() }, $inc: { revision: 1 } },
			{ streamKey, streamConsumedAt: null },
		);
	}

	async appendStreamChunkSegment(
		streamKey: string,
		segmentIndex: number,
		body: string,
	): Promise<boolean> {
		const pointer = await this.values.stage(
			`stream:${streamKey}:${segmentIndex}:${randomUUID()}`,
			body,
		);
		try {
			await this.runner.transaction(async (tx) => {
				await this.values.publish(pointer, tx);
				await tx.collection(collectionName(this.prefix, 'stream_segments')).insertOne({
					_id: `${streamKey}:${segmentIndex}`,
					streamKey,
					segmentIndex,
					body: pointer,
				});
			});
			return true;
		} catch (error) {
			await this.values.discardStaged(pointer);
			if (isDuplicate(error)) return false;
			throw error;
		}
	}

	async getStreamChunkSegments(
		streamKey: string,
	): Promise<Array<{ segmentIndex: number; body: string }>> {
		const rows = await this.c('stream_segments').find({ streamKey }, { sort: { segmentIndex: 1 } });
		const output = [];
		for (const row of rows)
			output.push({
				segmentIndex: Number(row.segmentIndex),
				body: (await this.values.read(row.body as unknown as StoredValue)) as string,
			});
		return output;
	}

	async deleteStreamChunkSegments(streamKey: string): Promise<void> {
		const rows = await this.c('stream_segments').find({ streamKey });
		await this.c('stream_segments').deleteMany({ streamKey });
		for (const row of rows)
			await this.values.retire(row.body as unknown as StoredValue).catch(() => undefined);
	}

	async replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		const row = await this.runner.transaction(async (tx) => {
			const set: MongoDocument = {
				attemptId: nextAttemptId,
				recoveryRequestedAt: null,
				startedAt: Date.now(),
			};
			if (lease) Object.assign(set, lease);
			const updated = await tx
				.collection(collectionName(this.prefix, 'submissions'))
				.findOneAndUpdate(
					{ submissionId: attempt.submissionId, status: 'running', attemptId: attempt.attemptId },
					{ $set: set, $inc: { attemptCount: 1 } },
					{ returnDocument: 'after' },
				);
			if (updated)
				await tx
					.collection(collectionName(this.prefix, 'journals'))
					.updateOne(
						{ submissionId: attempt.submissionId, attemptId: attempt.attemptId, committed: false },
						{ $set: { attemptId: nextAttemptId, updatedAt: Date.now() }, $inc: { revision: 1 } },
					);
			return updated;
		});
		return row ? this.parseSubmission(row) : null;
	}

	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admit(createDispatchAgentSubmissionInput(input));
	}
	async admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission> {
		const result = await this.admit(input);
		if (result.kind !== 'submission') throw new TypeError('Direct admission conflicted.');
		return result.submission;
	}

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const row = await this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const candidate = await submissions.findOne({
				submissionId: claim.submissionId,
				status: 'queued',
			});
			if (!candidate) return null;
			await touchGuard(tx, this.prefix, String(candidate.sessionKey));
			const earlier = await submissions.findOne({
				sessionKey: candidate.sessionKey,
				status: { $in: ['queued', 'running'] },
				sequence: { $lt: candidate.sequence },
			});
			if (earlier) return null;
			const now = Date.now();
			return submissions.findOneAndUpdate(
				{ submissionId: claim.submissionId, status: 'queued' },
				[
					{
						$set: {
							status: 'running',
							attemptId: claim.attemptId,
							startedAt: now,
							ownerId: claim.ownerId,
							leaseExpiresAt: claim.leaseExpiresAt,
							maxRetry: DURABILITY_DEFAULT_MAX_ATTEMPTS,
							timeoutAt: {
								$cond: [
									{ $eq: ['$timeoutAt', 0] },
									now + DURABILITY_DEFAULT_TIMEOUT_MS,
									'$timeoutAt',
								],
							},
							attemptCount: { $add: ['$attemptCount', 1] },
						},
					},
				],
				{ returnDocument: 'after' },
			);
		});
		return row ? this.parseSubmission(row) : null;
	}

	markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		return this.lifecycle(attempt, [
			{
				$set: {
					inputAppliedAt: { $ifNull: ['$inputAppliedAt', now] },
					maxRetry: {
						$cond: [
							{ $eq: [{ $ifNull: ['$inputAppliedAt', null] }, null] },
							durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
							'$maxRetry',
						],
					},
					timeoutAt: {
						$cond: [
							{ $eq: [{ $ifNull: ['$inputAppliedAt', null] }, null] },
							durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
							'$timeoutAt',
						],
					},
				},
			},
		]);
	}
	requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, [
			{ $set: { recoveryRequestedAt: { $ifNull: ['$recoveryRequestedAt', Date.now()] } } },
		]);
	}
	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(
			attempt,
			{
				$set: {
					status: 'queued',
					attemptId: null,
					recoveryRequestedAt: null,
					startedAt: null,
					ownerId: null,
					leaseExpiresAt: 0,
				},
			},
			{ inputAppliedAt: null },
		);
	}
	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, {
			$set: { status: 'settled', settledAt: Date.now(), error: null },
		});
	}
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return this.lifecycle(attempt, {
			$set: {
				status: 'settled',
				settledAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			},
		});
	}

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		try {
			await this.c('markers').insertOne({
				_id: `${attempt.submissionId}:${attempt.attemptId}`,
				...attempt,
				createdAt: Date.now(),
			});
		} catch (error) {
			if (!isDuplicate(error)) throw error;
		}
	}
	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		await this.c('markers').deleteOne({
			submissionId: attempt.submissionId,
			attemptId: attempt.attemptId,
		});
	}
	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		return (await this.c('markers').find()).map((row) => ({
			submissionId: String(row.submissionId),
			attemptId: String(row.attemptId),
			createdAt: Number(row.createdAt),
		}));
	}
	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length)
			await this.c('submissions').updateMany(
				{ ownerId, status: 'running', submissionId: { $in: submissionIds } },
				{ $set: { leaseExpiresAt: Date.now() + LEASE_DURATION_MS } },
			);
	}
	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ status: 'running', leaseExpiresAt: { $gt: 0, $lt: Date.now() } },
			{ sort: { sequence: 1 } },
		);
		return Promise.all(rows.map((row) => this.parseSubmission(row)));
	}
	deleteSession(sessionKey: string, callback: () => Promise<void>): Promise<void> {
		return deduplicateSessionDeletion(this.pending, sessionKey, () =>
			this.deleteSessionOwned(sessionKey, callback),
		);
	}
	async listPendingSessionDeletions(): Promise<string[]> {
		return (await this.c('deletions').find()).map((row) => String(row.sessionKey));
	}

	private async admit(
		input: DispatchAgentSubmissionInput | DirectAgentSubmissionInput,
	): Promise<AgentDispatchAdmission> {
		const prepared =
			input.kind === 'direct' ? prepareDirectSubmission(input) : { value: input, chunks: [] };
		const pointer = await this.values.stage(`submission:${input.submissionId}`, prepared.value);
		const owner = { kind: 'submission' as const, id: input.submissionId, part: 'input' };
		const stagedChunks = await stageChunks(this.runner, this.prefix, owner, prepared.chunks);
		const sessionKey = createSessionStorageKey(
			input.id,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${input.kind} admission`);
		let committed = false;
		try {
			const result = await this.runner.transaction(async (tx) => {
				if (input.kind === 'dispatch') {
					const receipt = await tx
						.collection(collectionName(this.prefix, 'receipts'))
						.findOne({ _id: input.submissionId });
					if (receipt)
						return {
							kind: 'retained_receipt',
							receipt: { submissionId: input.submissionId, acceptedAt: Number(receipt.acceptedAt) },
						} as AgentDispatchAdmission;
				}
				await touchGuard(tx, this.prefix, sessionKey);
				if (
					await tx.collection(collectionName(this.prefix, 'deletions')).findOne({ _id: sessionKey })
				)
					throw new TypeError(
						'Durable admission is unavailable while this session is being deleted.',
					);
				const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
				const existing = await submissions.findOne({ submissionId: input.submissionId });
				if (existing) return existing;
				await this.values.publish(pointer, tx);
				await publishChunks(tx, this.runner, this.prefix, stagedChunks);
				const counter = await tx
					.collection(collectionName(this.prefix, 'counters'))
					.findOneAndUpdate(
						{ _id: 'submission' },
						{ $inc: { value: 1 } },
						{ upsert: true, returnDocument: 'after' },
					);
				const row = {
					_id: input.submissionId,
					submissionId: input.submissionId,
					sessionKey,
					kind: input.kind,
					payload: pointer,
					chunks: stagedChunks.pointer,
					status: 'queued',
					acceptedAt,
					sequence: Number(counter?.value),
					attemptCount: 0,
					maxRetry: DURABILITY_DEFAULT_MAX_ATTEMPTS,
					timeoutAt: 0,
					leaseExpiresAt: 0,
				};
				await submissions.insertOne(row);
				return row;
			});
			const row = result as MongoDocument;
			committed = row.payload === pointer;
			if ('kind' in result && result.kind === 'retained_receipt') {
				await this.values.discardStaged(pointer);
				await this.values.discardStaged(stagedChunks.pointer);
				return result as AgentDispatchAdmission;
			}
			if (!committed) {
				await this.values.discardStaged(pointer);
				await this.values.discardStaged(stagedChunks.pointer);
				if (row.kind !== input.kind || row.sessionKey !== sessionKey) return { kind: 'conflict' };
				const persisted = await this.values.read(row.payload as unknown as StoredValue);
				const chunks = row.chunks
					? ((await this.values.read(row.chunks as unknown as StoredValue)) as Parameters<
							typeof matchesPersistedDirectSubmission
						>[2])
					: [];
				if (
					input.kind === 'direct'
						? !matchesPersistedDirectSubmission(
								input,
								persisted as DirectAgentSubmissionInput,
								chunks,
							)
						: JSON.stringify(persisted) !== JSON.stringify(input)
				)
					return { kind: 'conflict' };
			}
			return { kind: 'submission', submission: await this.parseSubmission(row) };
		} catch (error) {
			if (!committed) {
				await this.values.discardStaged(pointer);
				await this.values.discardStaged(stagedChunks.pointer);
			}
			throw error;
		}
	}

	private async deleteSessionOwned(
		sessionKey: string,
		callback: () => Promise<void>,
	): Promise<void> {
		const ownerId = randomUUID();
		let ownership: { cutoff: number; fence: number } | null = null;
		while (!ownership) {
			ownership = await this.runner.transaction(async (tx) => {
				await touchGuard(tx, this.prefix, sessionKey);
				if (
					await tx
						.collection(collectionName(this.prefix, 'submissions'))
						.findOne({ sessionKey, status: { $in: ['queued', 'running'] } })
				)
					throw new TypeError(
						'Session cannot be deleted while durable agent submissions are queued or running.',
					);
				const deletions = tx.collection(collectionName(this.prefix, 'deletions'));
				const current = await deletions.findOne({ _id: sessionKey });
				if (current && Number(current.leaseExpiresAt) >= Date.now() && current.ownerId !== ownerId)
					return null;
				const counter = await tx
					.collection(collectionName(this.prefix, 'counters'))
					.findOne({ _id: 'submission' });
				const fenceCounter = await tx
					.collection(collectionName(this.prefix, 'counters'))
					.findOneAndUpdate(
						{ _id: `deletion:${sessionKey}` },
						{ $inc: { value: 1 } },
						{ upsert: true, returnDocument: 'after' },
					);
				const next = {
					cutoff: Number(current?.cutoff ?? counter?.value ?? 0),
					fence: Number(fenceCounter?.value),
				};
				await deletions.updateOne(
					{ _id: sessionKey },
					{
						$set: {
							sessionKey,
							ownerId,
							...next,
							phase: 'callback',
							leaseExpiresAt: Date.now() + DELETION_LEASE_MS,
						},
					},
					{ upsert: true },
				);
				return next;
			});
			if (!ownership) {
				await new Promise((resolve) => setTimeout(resolve, DELETION_POLL_MS));
				if (!(await this.c('deletions').findOne({ _id: sessionKey }))) return;
			}
		}
		let lost = false;
		let heartbeatTask = Promise.resolve();
		const heartbeat = setInterval(() => {
			heartbeatTask = heartbeatTask.then(async () => {
				const renewed = await this.c('deletions')
					.updateOne(deletionOwnershipFilter(sessionKey, ownerId, ownership.fence, 'callback'), {
						$set: { leaseExpiresAt: Date.now() + DELETION_LEASE_MS },
					})
					.catch(() => null);
				if (!renewed || renewed.matchedCount !== 1) lost = true;
			});
		}, DELETION_LEASE_MS / 3);
		try {
			await callback();
		} catch (error) {
			clearInterval(heartbeat);
			await heartbeatTask;
			if (!lost)
				await this.c('deletions').deleteOne(
					deletionOwnershipFilter(sessionKey, ownerId, ownership.fence, 'callback'),
				);
			throw error;
		}
		clearInterval(heartbeat);
		await heartbeatTask;
		if (lost) return;
		const deleted = await this.runner.transaction(async (tx) => {
			await touchGuard(tx, this.prefix, sessionKey);
			const deletions = tx.collection(collectionName(this.prefix, 'deletions'));
			const marker = await deletions.findOneAndUpdate(
				deletionOwnershipFilter(sessionKey, ownerId, ownership.fence, 'callback'),
				{ $set: { phase: 'cleanup', leaseExpiresAt: Date.now() + DELETION_LEASE_MS } },
				{ returnDocument: 'after' },
			);
			if (!marker) return { rows: [], journals: [] };
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const rows = await submissions.find({
				sessionKey,
				status: 'settled',
				sequence: { $lte: ownership.cutoff },
			});
			const ids = rows.map((row) => row.submissionId);
			for (const row of rows)
				if (row.kind === 'dispatch')
					await tx
						.collection(collectionName(this.prefix, 'receipts'))
						.updateOne(
							{ _id: row.submissionId },
							{ $setOnInsert: { acceptedAt: row.acceptedAt } },
							{ upsert: true },
						);
			const journals = [];
			for (let offset = 0; offset < ids.length; offset += 100) {
				const batch = ids.slice(offset, offset + 100);
				journals.push(
					...(await tx
						.collection(collectionName(this.prefix, 'journals'))
						.find({ submissionId: { $in: batch } })),
				);
				await tx
					.collection(collectionName(this.prefix, 'journals'))
					.deleteMany({ submissionId: { $in: batch } });
				await submissions.deleteMany({
					submissionId: { $in: batch },
					sessionKey,
					status: 'settled',
					sequence: { $lte: ownership.cutoff },
				});
			}
			await deletions.deleteOne(
				deletionOwnershipFilter(sessionKey, ownerId, ownership.fence, 'cleanup'),
			);
			return { rows, journals };
		});
		for (const journal of deleted.journals) {
			if (journal.toolRequest)
				await this.values
					.retire(journal.toolRequest as unknown as StoredValue)
					.catch(() => undefined);
			if (journal.streamKey) await this.deleteStreamChunkSegments(String(journal.streamKey));
		}
		for (const row of deleted.rows) {
			await this.values.retire(row.payload as unknown as StoredValue).catch(() => undefined);
			if (row.chunks)
				await this.values.retire(row.chunks as unknown as StoredValue).catch(() => undefined);
		}
	}

	private async lifecycle(
		attempt: SubmissionAttemptRef,
		update: MongoDocument | MongoDocument[],
		extra: MongoDocument = {},
	): Promise<boolean> {
		const result = await this.c('submissions').updateOne(
			{
				submissionId: attempt.submissionId,
				attemptId: attempt.attemptId,
				status: 'running',
				...extra,
			},
			update,
		);
		return result.matchedCount === 1;
	}
	private async journalUpdate(
		attempt: SubmissionAttemptRef,
		update: MongoDocument,
		extra: MongoDocument = {},
	): Promise<boolean> {
		const result = await this.c('journals').updateOne(
			{
				submissionId: attempt.submissionId,
				attemptId: attempt.attemptId,
				committed: false,
				...extra,
			},
			update,
		);
		return result.matchedCount === 1;
	}
	private c(name: string) {
		return this.runner.collection(collectionName(this.prefix, name));
	}
	private async parseSubmission(row: MongoDocument): Promise<AgentSubmission> {
		const persisted = await this.values.read(row.payload as unknown as StoredValue);
		const chunks =
			row.kind === 'direct' && row.chunks
				? ((await this.values.read(row.chunks as unknown as StoredValue)) as Parameters<
						typeof hydratePersistedDirectSubmission
					>[1])
				: [];
		const input =
			row.kind === 'direct'
				? hydratePersistedDirectSubmission(persisted as DirectAgentSubmissionInput, chunks)
				: persisted;
		if (
			!isSubmissionPayload(input, {
				kind: String(row.kind),
				submissionId: String(row.submissionId),
				sessionKey: String(row.sessionKey),
				acceptedAt: Number(row.acceptedAt),
			})
		)
			throw new TypeError('Persisted MongoDB submission is malformed.');
		return {
			sequence: Number(row.sequence),
			submissionId: String(row.submissionId),
			sessionKey: String(row.sessionKey),
			kind: row.kind as 'dispatch' | 'direct',
			input,
			status: row.status as AgentSubmission['status'],
			acceptedAt: Number(row.acceptedAt),
			...(row.attemptId ? { attemptId: String(row.attemptId) } : {}),
			...(row.inputAppliedAt ? { inputAppliedAt: Number(row.inputAppliedAt) } : {}),
			...(row.recoveryRequestedAt ? { recoveryRequestedAt: Number(row.recoveryRequestedAt) } : {}),
			...(row.startedAt ? { startedAt: Number(row.startedAt) } : {}),
			...(row.error ? { error: String(row.error) } : {}),
			attemptCount: Number(row.attemptCount),
			maxRetry: Number(row.maxRetry),
			timeoutAt: Number(row.timeoutAt),
			...(row.ownerId ? { ownerId: String(row.ownerId) } : {}),
			leaseExpiresAt: Number(row.leaseExpiresAt),
		};
	}
}

async function touchGuard(
	operations: MongoOperations,
	prefix: string,
	sessionKey: string,
): Promise<void> {
	await operations
		.collection(collectionName(prefix, 'guards'))
		.updateOne(
			{ _id: sessionKey },
			{ $inc: { revision: 1 }, $setOnInsert: { sessionKey } },
			{ upsert: true },
		);
}
function isDuplicate(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { code: unknown }).code === 11000,
	);
}
