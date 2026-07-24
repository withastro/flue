import type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionInput,
	AgentSubmissionStore,
	DispatchInput,
	SubmissionAttemptRef,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	hydratePersistedSubmissionAttachments,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	matchesPersistedSubmissionAttachments,
	parseAcceptedAt,
	prepareSubmissionAttachments,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from '@flue/runtime/adapter';
import type { MongoCollection, MongoDocument, MongoRunner } from './mongodb-runner.ts';
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

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		const row = await this.c('submissions').findOneAndUpdate(
			{ submissionId, status: 'queued' },
			[{ $set: { canonicalReadyAt: { $ifNull: ['$canonicalReadyAt', Date.now()] } } }],
			{ returnDocument: 'after' },
		);
		return row ? this.parseSubmission(row) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return Boolean(
			await this.c('submissions').findOne({
				status: { $in: ['queued', 'running', 'terminalizing', 'joining', 'joined'] },
			}),
		);
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ status: 'queued', canonicalReadyAt: null },
			{ sort: { sequence: 1 } },
		);
		return this.parseOperationalRows(rows, 'queued');
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ status: { $in: ['queued', 'running', 'terminalizing', 'joining', 'joined'] } },
			{ sort: { sequence: 1 } },
		);
		const seen = new Set<string>();
		const heads: MongoDocument[] = [];
		for (const row of rows)
			if (!seen.has(String(row.sessionKey))) {
				seen.add(String(row.sessionKey));
				if (row.status === 'queued' && row.canonicalReadyAt != null) heads.push(row);
			}
		return this.parseOperationalRows(heads, 'queued');
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find({ status: 'running' }, { sort: { sequence: 1 } });
		return this.parseOperationalRows(rows, 'active');
	}

	async replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		const row = await this.runner.transaction(async (tx) => {
			const set: MongoDocument = {
				attemptId: nextAttemptId,
				startedAt: Date.now(),
			};
			if (lease) Object.assign(set, lease);
			return tx
				.collection(collectionName(this.prefix, 'submissions'))
				.findOneAndUpdate(
					{ submissionId: attempt.submissionId, status: 'running', attemptId: attempt.attemptId },
					{ $set: set, $inc: { attemptCount: 1 } },
					{ returnDocument: 'after' },
				);
		});
		return row ? this.parseSubmission(row) : null;
	}

	admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admit(createDispatchAgentSubmissionInput(input));
	}
	async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
		const result = await this.admit(input);
		if (result.kind !== 'submission')
			throw new TypeError('[flue] Internal direct admission returned an unexpected result.');
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
				status: { $in: ['queued', 'running', 'terminalizing', 'joining', 'joined'] },
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
							maxAttempts: DURABILITY_DEFAULT_MAX_ATTEMPTS,
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
		durability?: { maxAttempts: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		return this.lifecycle(attempt, [
			{
				$set: {
					inputAppliedAt: { $ifNull: ['$inputAppliedAt', now] },
					maxAttempts: {
						$cond: [
							{ $eq: [{ $ifNull: ['$inputAppliedAt', null] }, null] },
							durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
							'$maxAttempts',
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
	requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, {
			$set: {
				status: 'queued',
				attemptId: null,
				inputAppliedAt: null,
				startedAt: null,
				ownerId: null,
				leaseExpiresAt: 0,
			},
		});
	}
	async requestSessionAbort(sessionKey: string): Promise<string[]> {
		const filter = { sessionKey, status: { $in: ['queued', 'running', 'joining', 'joined'] } };
		const rows = await this.c('submissions').find(filter);
		if (rows.length === 0) return [];
		await this.c('submissions').updateMany(filter, [
			{ $set: { abortRequestedAt: { $ifNull: ['$abortRequestedAt', Date.now()] } } },
		]);
		return rows.map((row) => String(row.submissionId));
	}

	async listPendingSubmissionSettlements(): Promise<
		import('@flue/runtime/adapter').SubmissionSettlementObligation[]
	> {
		return (
			await this.c('submissions').find({ status: 'terminalizing' }, { sort: { sequence: 1 } })
		).map((row) => ({
			submissionId: String(row.submissionId),
			sessionKey: String(row.sessionKey),
			attemptId: String(row.attemptId),
			recordId: String(row.settlementRecordId),
			record: row.settlementRecord as import('@flue/runtime/adapter').SubmissionSettledRecord,
		}));
	}
	async reserveSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		settlement: {
			recordId: string;
			record: import('@flue/runtime/adapter').SubmissionSettledRecord;
		},
	): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		return this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			// Two reservable shapes, for either submission kind: the submission's
			// own running attempt, or a delivery JOINED into a host that is
			// running under the caller's attempt — the host settles the joined
			// waiter's record under its own authority, adopting the row
			// (attemptId/startedAt) so the terminalizing invariants and
			// finalize fencing hold.
			let row = await submissions.findOneAndUpdate(
				{
					submissionId: attempt.submissionId,
					status: 'running',
					attemptId: attempt.attemptId,
					ownerId: { $ne: null },
					settlementRecordId: null,
				},
				{
					$set: {
						status: 'terminalizing',
						settlementRecordId: settlement.recordId,
						settlementRecord: settlement.record,
					},
				},
				{ returnDocument: 'after' },
			);
			if (!row) {
				const joined = await submissions.findOne({
					submissionId: attempt.submissionId,
					status: 'joined',
				});
				const host = joined?.joinedInto
					? await submissions.findOne({
							submissionId: joined.joinedInto,
							status: 'running',
							attemptId: attempt.attemptId,
						})
					: null;
				if (host) {
					// Same top-level not-already-reserved guard as the running
					// branch (Postgres spelling): never re-reserve with a
					// different record.
					row = await submissions.findOneAndUpdate(
						{
							submissionId: attempt.submissionId,
							status: 'joined',
							joinedInto: joined?.joinedInto,
							settlementRecordId: null,
						},
						[
							{
								$set: {
									status: 'terminalizing',
									settlementRecordId: settlement.recordId,
									settlementRecord: settlement.record,
									attemptId: attempt.attemptId,
									startedAt: { $ifNull: ['$startedAt', Date.now()] },
								},
							},
						],
						{ returnDocument: 'after' },
					);
				}
			}
			const current =
				row ??
				(await submissions.findOne({
					submissionId: attempt.submissionId,
					status: 'terminalizing',
					attemptId: attempt.attemptId,
				}));
			if (
				!current ||
				current.settlementRecordId !== settlement.recordId ||
				JSON.stringify(current.settlementRecord) !== JSON.stringify(settlement.record)
			)
				return null;
			return {
				submissionId: String(current.submissionId),
				sessionKey: String(current.sessionKey),
				attemptId: String(current.attemptId),
				recordId: String(current.settlementRecordId),
				record: current.settlementRecord as import('@flue/runtime/adapter').SubmissionSettledRecord,
			};
		});
	}
	async finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
		options?: { errorMessage?: string },
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const pending = await submissions.findOne({
				submissionId: attempt.submissionId,
				status: 'terminalizing',
				attemptId: attempt.attemptId,
				settlementRecordId: recordId,
			});
			if (!pending) return false;
			// The durable settlement record is the outcome authority; the row's
			// error field mirrors it — the caller's raw server-side message when
			// provided, else the record's client-safe one.
			const record = pending.settlementRecord as { outcome?: string; error?: { message?: string } };
			const errorMessage =
				record.outcome === 'completed'
					? null
					: (options?.errorMessage ?? record.error?.message ?? 'The submission did not complete.');
			const row = await submissions.findOneAndUpdate(
				{
					submissionId: attempt.submissionId,
					status: 'terminalizing',
					attemptId: attempt.attemptId,
					settlementRecordId: recordId,
				},
				{ $set: { status: 'settled', settledAt: Date.now(), error: errorMessage } },
				{ returnDocument: 'after' },
			);
			if (!row) return false;
			// A host settles through the outbox; fan its outcome out to joined
			// deliveries the same way completeSubmission/failSubmission do.
			await this.settleJoinedSubmissions(submissions, attempt.submissionId, errorMessage);
			return true;
		});
	}

	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.settleWithJoinedFanOut(attempt, null);
	}
	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return this.settleWithJoinedFanOut(
			attempt,
			error instanceof Error ? error.message : String(error),
		);
	}
	private settleWithJoinedFanOut(
		attempt: SubmissionAttemptRef,
		error: string | null,
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const settled = await submissions.updateOne(
				{ submissionId: attempt.submissionId, attemptId: attempt.attemptId, status: 'running' },
				{ $set: { status: 'settled', settledAt: Date.now(), error } },
			);
			if (settled.matchedCount !== 1) return false;
			await this.settleJoinedSubmissions(submissions, attempt.submissionId, error);
			return true;
		});
	}

	async claimJoinableSubmissions(
		host: SubmissionAttemptRef,
		agentName: string,
	): Promise<AgentSubmission[]> {
		return this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const hostRow = await submissions.findOne({
				submissionId: host.submissionId,
				status: 'running',
				attemptId: host.attemptId,
			});
			if (!hostRow) return [];
			const queued = await submissions.find(
				{ sessionKey: hostRow.sessionKey, status: 'queued' },
				{ sort: { sequence: 1 } },
			);
			const claimed: AgentSubmission[] = [];
			for (const row of queued) {
				// Contiguous prefix: the first non-joinable row ends the claim so
				// admission order is preserved (everything behind it stays queued).
				if (row.canonicalReadyAt == null || row.abortRequestedAt != null) break;
				// A malformed row is not joinable and must not fail the host's
				// attempt; it stays queued for the head-scan to terminate once it
				// becomes the session head.
				let submission: AgentSubmission;
				try {
					submission = await this.parseSubmission(row);
				} catch {
					break;
				}
				if (submission.input.agent !== agentName) break;
				const update = await submissions.updateOne(
					{ submissionId: submission.submissionId, status: 'queued' },
					{ $set: { status: 'joining', joinedInto: host.submissionId } },
				);
				if (update.matchedCount !== 1) break;
				claimed.push({ ...submission, status: 'joining', joinedInto: host.submissionId });
			}
			return claimed;
		});
	}
	async finalizeJoinedSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const hostRow = await submissions.findOne({
				submissionId: host.submissionId,
				status: 'running',
				attemptId: host.attemptId,
			});
			if (!hostRow) return false;
			const result = await submissions.updateOne(
				{ submissionId, status: 'joining', joinedInto: host.submissionId },
				[
					{
						$set: {
							status: 'joined',
							inputAppliedAt: { $ifNull: ['$inputAppliedAt', Date.now()] },
						},
					},
				],
			);
			return result.matchedCount === 1;
		});
	}
	async revertJoiningSubmission(
		host: SubmissionAttemptRef,
		submissionId: string,
	): Promise<boolean> {
		return this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const hostRow = await submissions.findOne({
				submissionId: host.submissionId,
				status: 'running',
				attemptId: host.attemptId,
			});
			if (!hostRow) return false;
			const result = await submissions.updateOne(
				{ submissionId, status: 'joining', joinedInto: host.submissionId },
				{ $set: { status: 'queued', joinedInto: null, inputAppliedAt: null } },
			);
			return result.matchedCount === 1;
		});
	}
	async listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]> {
		const rows = await this.c('submissions').find(
			{ joinedInto: hostSubmissionId, status: { $in: ['joining', 'joined'] } },
			{ sort: { sequence: 1 } },
		);
		return this.parseOperationalRows(rows, 'active');
	}
	/**
	 * Joined-delivery settle fan-out, run inside the host's settle
	 * transaction: `joined` rows settle with the host's outcome (`error`
	 * copied, null on success); `joining` stragglers — a join whose canonical
	 * input was never confirmed (abort or crash window) — revert to `queued`
	 * so the delivery runs as its own submission instead of vanishing.
	 */
	private async settleJoinedSubmissions(
		submissions: MongoCollection,
		hostSubmissionId: string,
		error: string | null,
	): Promise<void> {
		await submissions.updateMany(
			{ joinedInto: hostSubmissionId, status: 'joined' },
			{ $set: { status: 'settled', settledAt: Date.now(), error } },
		);
		await submissions.updateMany(
			{ joinedInto: hostSubmissionId, status: 'joining' },
			{ $set: { status: 'queued', joinedInto: null, inputAppliedAt: null } },
		);
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
		return this.parseOperationalRows(rows, 'active');
	}
	private async admit(input: AgentSubmissionInput): Promise<AgentDispatchAdmission> {
		const prepared = prepareSubmissionAttachments(input);
		const pointer = await this.values.stage(`submission:${input.submissionId}`, prepared.value);
		const chunksPointer = await this.values.stage(
			`submission_chunks:${input.submissionId}`,
			prepared.chunks,
		);
		const sessionKey = createSessionStorageKey(
			input.agent,
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
				await this.values.publish(chunksPointer, tx);
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
					chunks: chunksPointer,
					status: 'queued',
					canonicalReadyAt: null,
					acceptedAt,
					sequence: Number(counter?.value),
					attemptCount: 0,
					maxAttempts: DURABILITY_DEFAULT_MAX_ATTEMPTS,
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
				await this.values.discardStaged(chunksPointer);
				if (row.kind !== input.kind || row.sessionKey !== sessionKey) return { kind: 'conflict' };
				const persisted = await this.values.read(row.payload as unknown as StoredValue);
				const chunks = row.chunks
					? ((await this.values.read(row.chunks as unknown as StoredValue)) as Parameters<
							typeof matchesPersistedSubmissionAttachments
						>[2])
					: [];
				if (
					!matchesPersistedSubmissionAttachments(input, persisted as AgentSubmissionInput, chunks)
				)
					return { kind: 'conflict' };
			}
			return { kind: 'submission', submission: await this.parseSubmission(row) };
		} catch (error) {
			if (!committed) {
				await this.values.discardStaged(pointer);
				await this.values.discardStaged(chunksPointer);
			}
			throw error;
		}
	}

	/**
	 * Parse each operational row, terminalizing any row whose persisted value
	 * is malformed (fail → settled) so one bad row cannot wedge the store —
	 * the same per-row isolation the SQL backends implement.
	 */
	private async parseOperationalRows(
		rows: MongoDocument[],
		status: 'queued' | 'active',
	): Promise<AgentSubmission[]> {
		const output: AgentSubmission[] = [];
		for (const row of rows) {
			try {
				output.push(await this.parseSubmission(row));
			} catch (error) {
				const sequence = Number(row.sequence);
				if (!Number.isFinite(sequence)) throw error;
				console.error('[flue] Terminating malformed submission (sequence %d):', sequence, error);
				await this.failSubmissionSequence(sequence, status, error);
			}
		}
		return output;
	}

	private async failSubmissionSequence(
		sequence: number,
		status: 'queued' | 'active',
		error: unknown,
	): Promise<void> {
		const message = error instanceof Error ? error.message : String(error);
		await this.runner.transaction(async (tx) => {
			const submissions = tx.collection(collectionName(this.prefix, 'submissions'));
			const row = await submissions.findOneAndUpdate(
				{ sequence, status: status === 'queued' ? 'queued' : 'running' },
				{ $set: { status: 'settled', settledAt: Date.now(), error: message } },
				{ returnDocument: 'after' },
			);
			// A terminated running host can have joined deliveries gated on its
			// attempt; without the fan-out they would stay unsettled forever and
			// wedge the session queue.
			if (row) await this.settleJoinedSubmissions(submissions, String(row.submissionId), message);
		});
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
	private c(name: string) {
		return this.runner.collection(collectionName(this.prefix, name));
	}
	private async parseSubmission(row: MongoDocument): Promise<AgentSubmission> {
		const persisted = await this.values.read(row.payload as unknown as StoredValue);
		const chunks = row.chunks
			? ((await this.values.read(row.chunks as unknown as StoredValue)) as Parameters<
					typeof hydratePersistedSubmissionAttachments
				>[1])
			: [];
		const input = hydratePersistedSubmissionAttachments(persisted as AgentSubmissionInput, chunks);
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
			...(row.abortRequestedAt ? { abortRequestedAt: Number(row.abortRequestedAt) } : {}),
			...(row.startedAt ? { startedAt: Number(row.startedAt) } : {}),
			...(row.joinedInto ? { joinedInto: String(row.joinedInto) } : {}),
			...(row.error ? { error: String(row.error) } : {}),
			...(row.settledAt != null ? { settledAt: Number(row.settledAt) } : {}),
			attemptCount: Number(row.attemptCount),
			maxAttempts: Number(row.maxAttempts),
			timeoutAt: Number(row.timeoutAt),
			...(row.ownerId ? { ownerId: String(row.ownerId) } : {}),
			leaseExpiresAt: Number(row.leaseExpiresAt),
		};
	}
}
