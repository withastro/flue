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
import type { MongoDocument, MongoRunner } from './mongodb-runner.ts';
import { collectionName } from './schema.ts';
import { type StoredValue, ValueStore } from './value-store.ts';

export class MongoSubmissionStore implements AgentSubmissionStore {
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
			committed: Boolean(row.committed),
			...(row.committedLeafId ? { committedLeafId: String(row.committedLeafId) } : {}),
		};
	}

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		const row = await this.c('submissions').findOneAndUpdate(
			{ submissionId, status: 'queued' },
			[{ $set: { canonicalReadyAt: { $ifNull: ['$canonicalReadyAt', Date.now()] } } }],
			{ returnDocument: 'after' },
		);
		return row ? this.parseSubmission(row) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return Boolean(await this.c('submissions').findOne({ status: { $in: ['queued', 'running', 'terminalizing'] } }));
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ status: 'queued', canonicalReadyAt: null },
			{ sort: { sequence: 1 } },
		);
		const output: AgentSubmission[] = [];
		for (const row of rows) output.push(await this.parseSubmission(row));
		return output;
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ status: { $in: ['queued', 'running', 'terminalizing'] } },
			{ sort: { sequence: 1 } },
		);
		const seen = new Set<string>();
		const output: AgentSubmission[] = [];
		for (const row of rows)
			if (!seen.has(String(row.sessionKey))) {
				seen.add(String(row.sessionKey));
				if (row.status === 'queued' && row.canonicalReadyAt != null)
					output.push(await this.parseSubmission(row));
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
		options: { checkpointLeafId?: string; toolRequest?: unknown } = {},
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
				canonicalReadyAt: { $ne: null },
			});
			if (!candidate) return null;
			const earlier = await submissions.findOne({
				sessionKey: candidate.sessionKey,
				status: { $in: ['queued', 'running', 'terminalizing'] },
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
	async listPendingSubmissionSettlements(): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation[]> {
		return (await this.c('submissions').find({ kind: 'direct', status: 'terminalizing' }, { sort: { sequence: 1 } })).map((row) => ({ submissionId: String(row.submissionId), sessionKey: String(row.sessionKey), attemptId: String(row.attemptId), recordId: String(row.settlementRecordId), record: row.settlementRecord as import('@flue/runtime/adapter').SubmissionSettledRecord }));
	}
	async reserveSubmissionSettlement(attempt: SubmissionAttemptRef, settlement: { recordId: string; record: import('@flue/runtime/adapter').SubmissionSettledRecord }): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		const row = await this.c('submissions').findOneAndUpdate(
			{ submissionId: attempt.submissionId, kind: 'direct', status: 'running', attemptId: attempt.attemptId, ownerId: { $ne: null }, settlementRecordId: null },
			{ $set: { status: 'terminalizing', settlementRecordId: settlement.recordId, settlementRecord: settlement.record } }, { returnDocument: 'after' });
		const current = row ?? await this.c('submissions').findOne({ submissionId: attempt.submissionId, status: 'terminalizing', attemptId: attempt.attemptId });
		if (!current || current.settlementRecordId !== settlement.recordId || JSON.stringify(current.settlementRecord) !== JSON.stringify(settlement.record)) return null;
		return { submissionId: String(current.submissionId), sessionKey: String(current.sessionKey), attemptId: String(current.attemptId), recordId: String(current.settlementRecordId), record: current.settlementRecord as import('@flue/runtime/adapter').SubmissionSettledRecord };
	}
	async finalizeSubmissionSettlement(attempt: SubmissionAttemptRef, recordId: string): Promise<boolean> {
		const result = await this.c('submissions').updateOne({ submissionId: attempt.submissionId, kind: 'direct', status: 'terminalizing', attemptId: attempt.attemptId, settlementRecordId: recordId }, { $set: { status: 'settled', settledAt: Date.now() } });
		return result.matchedCount === 1;
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
	private async admit(
		input: DispatchAgentSubmissionInput | DirectAgentSubmissionInput,
	): Promise<AgentDispatchAdmission> {
		const prepared =
			input.kind === 'direct' ? prepareDirectSubmission(input) : { value: input, chunks: [] };
		const pointer = await this.values.stage(`submission:${input.submissionId}`, prepared.value);
		const owner = { kind: 'submission' as const, id: input.submissionId, part: '' as const };
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
					canonicalReadyAt: null,
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
			canonicalReadyAt: row.canonicalReadyAt == null ? null : Number(row.canonicalReadyAt),
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
function isDuplicate(error: unknown): boolean {
	return Boolean(
		error &&
		typeof error === 'object' &&
		'code' in error &&
		(error as { code: unknown }).code === 11000,
	);
}
