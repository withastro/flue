/**
 * LMDB persistence adapter.
 *
 * Implements {@link AgentSubmissionStore} and {@link SessionStore} against LMDB,
 * a memory-mapped key-value store. This demonstrates the persistence adapter
 * interface against a non-SQL data model.
 *
 * ## Data model
 *
 * All data lives in a single LMDB environment with named sub-databases:
 *
 * - `sessions`: key = storage id, value = SessionData (JSON object)
 * - `submissions`: key = submissionId, value = submission document
 * - `journals`: key = submissionId, value = journal document
 * - `receipts`: key = dispatchId, value = { acceptedAt, settledAt }
 * - `deletions`: key = sessionKey, value = { startedAt }
 */

import { open, type Database, type RootDatabase } from 'lmdb';
import type {
	AgentDispatchAdmission,
	AgentExecutionStore,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateTurnJournalInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
} from '@flue/runtime';
import type { DirectAgentSubmissionInput, DispatchInput, SessionData, SessionStore } from '@flue/runtime';
import {
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	deduplicateSessionDeletion,
	DURABILITY_DEFAULT_MAX_RETRY,
	DURABILITY_DEFAULT_TIMEOUT_MINUTES,
	isSubmissionPayload,
	parseAcceptedAt,
} from '@flue/runtime/internal';
import type { DispatchAgentSubmissionInput } from '@flue/runtime/internal';

// ─── Internal document types ────────────────────────────────────────────────
// These are the shapes stored in LMDB. They mirror the SQL column layout but
// as plain objects rather than relational rows.

interface SubmissionDoc {
	sequence: number;
	submissionId: string;
	sessionKey: string;
	kind: 'dispatch' | 'direct';
	payload: string; // JSON-serialized AgentSubmissionInput
	status: 'queued' | 'running' | 'settled';
	acceptedAt: number;
	attemptId: string | null;
	inputAppliedAt: number | null;
	recoveryRequestedAt: number | null;
	startedAt: number | null;
	settledAt: number | null;
	error: string | null;
	attemptCount: number;
	maxRetry: number;
	timeoutAt: number;
}

interface JournalDoc {
	submissionId: string;
	sessionKey: string;
	kind: 'dispatch' | 'direct';
	attemptId: string;
	operationId: string;
	turnId: string;
	phase: AgentTurnJournalPhase;
	revision: number;
	createdAt: number;
	updatedAt: number;
	checkpointLeafId: string | null;
	toolRequestJson: string | null;
	committed: boolean;
	committedLeafId: string | null;
}

interface ReceiptDoc {
	acceptedAt: number;
	settledAt: number;
}

interface DeletionDoc {
	startedAt: number;
}

// ─── Public factory ─────────────────────────────────────────────────────────

/**
 * Create an LMDB-backed {@link PersistenceAdapter}.
 *
 * @param path - Directory for the LMDB environment. Use a temp directory
 *   for tests. LMDB creates the directory if it doesn't exist.
 */
export function lmdb(path: string): PersistenceAdapter {
	if (!path || !path.trim()) {
		throw new Error('[flue] lmdb() requires a non-empty path.');
	}
	let env: RootDatabase | undefined;

	return {
		connect() {
			if (env) throw new Error('[flue] connect() was already called on this adapter.');
			env = open({ path, compression: false });
			return createLmdbExecutionStore(env);
		},
		async close() {
			if (!env) return;
			await env.close();
			env = undefined;
		},
	};
}

// ─── Store construction ─────────────────────────────────────────────────────

function createLmdbExecutionStore(env: RootDatabase): AgentExecutionStore {
	const sessions = env.openDB<SessionData, string>('sessions', { encoding: 'json' });
	const submissions = env.openDB<SubmissionDoc, string>('submissions', { encoding: 'json' });
	const journals = env.openDB<JournalDoc, string>('journals', { encoding: 'json' });
	const receipts = env.openDB<ReceiptDoc, string>('receipts', { encoding: 'json' });
	const deletions = env.openDB<DeletionDoc, string>('deletions', { encoding: 'json' });

	// Initialize the in-memory sequence counter from existing data.
	let maxSequence = 0;
	for (const { value } of submissions.getRange()) {
		if (value.sequence > maxSequence) maxSequence = value.sequence;
	}

	return {
		sessions: new LmdbSessionStore(sessions),
		submissions: new LmdbSubmissionStore(env, submissions, journals, receipts, deletions, maxSequence),
	};
}

// ─── Session store ──────────────────────────────────────────────────────────

class LmdbSessionStore implements SessionStore {
	constructor(private db: Database<SessionData, string>) {}

	async save(id: string, data: SessionData): Promise<void> {
		await this.db.put(id, data);
	}

	async load(id: string): Promise<SessionData | null> {
		return this.db.get(id) ?? null;
	}

	async delete(id: string): Promise<void> {
		await this.db.remove(id);
	}
}

// ─── Submission store ───────────────────────────────────────────────────────

class LmdbSubmissionStore implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();
	private sequenceCounter: number;

	constructor(
		private env: RootDatabase,
		private subs: Database<SubmissionDoc, string>,
		private journals: Database<JournalDoc, string>,
		private receipts: Database<ReceiptDoc, string>,
		private deletions: Database<DeletionDoc, string>,
		initialSequence: number,
	) {
		this.sequenceCounter = initialSequence;
	}

	// ── Sequence generation ──────────────────────────────────────────────

	private nextSequence(): number {
		return ++this.sequenceCounter;
	}

	// ── Query ────────────────────────────────────────────────────────────

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const doc = this.subs.get(submissionId);
		return doc ? docToSubmission(doc) : null;
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const doc = this.journals.get(submissionId);
		return doc ? docToJournal(doc) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		for (const { value } of this.subs.getRange()) {
			if (value.status === 'queued' || value.status === 'running') return true;
		}
		return false;
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		// Find the oldest queued submission per session that has no earlier
		// unsettled work for that same session.
		const sessionHeads = new Map<string, SubmissionDoc>();
		for (const { value: doc } of this.subs.getRange()) {
			if (doc.status === 'settled') continue;
			const existing = sessionHeads.get(doc.sessionKey);
			if (!existing || doc.sequence < existing.sequence) {
				sessionHeads.set(doc.sessionKey, doc);
			}
		}
		const result: AgentSubmission[] = [];
		for (const doc of sessionHeads.values()) {
			if (doc.status === 'queued') {
				try {
					result.push(docToSubmission(doc));
				} catch (error) {
					await this.failDocById(doc.submissionId, 'queued', error);
				}
			}
		}
		// Sort by sequence for deterministic ordering.
		result.sort((a, b) => a.sequence - b.sequence);
		return result;
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		const result: AgentSubmission[] = [];
		for (const { value: doc } of this.subs.getRange()) {
			if (doc.status !== 'running') continue;
			try {
				result.push(docToSubmission(doc));
			} catch (error) {
				await this.failDocById(doc.submissionId, 'active', error);
			}
		}
		result.sort((a, b) => a.sequence - b.sequence);
		return result;
	}

	// ── Turn journal lifecycle ───────────────────────────────────────────

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const now = Date.now();
		const existing = this.journals.get(input.submissionId);
		const doc: JournalDoc = {
			submissionId: input.submissionId,
			sessionKey: input.sessionKey,
			kind: input.kind,
			attemptId: input.attemptId,
			operationId: input.operationId,
			turnId: input.turnId,
			phase: input.phase,
			revision: existing ? existing.revision + 1 : 1,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
			checkpointLeafId: input.checkpointLeafId ?? null,
			toolRequestJson: input.toolRequest === undefined ? null : JSON.stringify(input.toolRequest),
			committed: false,
			committedLeafId: null,
		};
		await this.journals.put(input.submissionId, doc);
		return true;
	}

	async updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options: { checkpointLeafId?: string; toolRequest?: unknown } = {},
	): Promise<boolean> {
		const doc = this.journals.get(attempt.submissionId);
		if (!doc || doc.attemptId !== attempt.attemptId || doc.committed) return false;
		const updated: JournalDoc = {
			...doc,
			phase,
			revision: doc.revision + 1,
			updatedAt: Date.now(),
			checkpointLeafId: options.checkpointLeafId ?? doc.checkpointLeafId,
			toolRequestJson: options.toolRequest === undefined
				? doc.toolRequestJson
				: JSON.stringify(options.toolRequest),
		};
		await this.journals.put(attempt.submissionId, updated);
		return true;
	}

	async commitTurnJournal(attempt: SubmissionAttemptRef, committedLeafId: string): Promise<boolean> {
		const doc = this.journals.get(attempt.submissionId);
		if (!doc || doc.attemptId !== attempt.attemptId || doc.committed) return false;
		const updated: JournalDoc = {
			...doc,
			phase: 'committed',
			revision: doc.revision + 1,
			updatedAt: Date.now(),
			committed: true,
			committedLeafId,
		};
		await this.journals.put(attempt.submissionId, updated);
		return true;
	}

	async replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
	): Promise<AgentSubmission | null> {
		// Must update both submission and journal atomically.
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (!sub || sub.status !== 'running' || sub.attemptId !== attempt.attemptId) return null;

			const now = Date.now();
			const updatedSub: SubmissionDoc = {
				...sub,
				attemptId: nextAttemptId,
				recoveryRequestedAt: null,
				startedAt: now,
				attemptCount: sub.attemptCount + 1,
			};
			this.subs.putSync(attempt.submissionId, updatedSub);

			const journal = this.journals.get(attempt.submissionId);
			if (journal && journal.attemptId === attempt.attemptId && !journal.committed) {
				this.journals.putSync(attempt.submissionId, {
					...journal,
					attemptId: nextAttemptId,
					revision: journal.revision + 1,
					updatedAt: now,
				});
			}

			return docToSubmission(updatedSub);
		});
	}

	// ── Admission ────────────────────────────────────────────────────────

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission> {
		const admission = await this.admitSubmission(input);
		if (admission.kind !== 'submission') {
			throw new Error('[flue] Internal direct admission returned an unexpected result.');
		}
		return admission.submission;
	}

	// ── Submission lifecycle ─────────────────────────────────────────────

	async claimSubmission(
		attempt: SubmissionAttemptRef,
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<AgentSubmission | null> {
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (!sub || sub.status !== 'queued') return null;

			// Enforce session ordering: only claim if no earlier unsettled submission
			// exists for the same session.
			for (const { value: doc } of this.subs.getRange()) {
				if (doc.sessionKey !== sub.sessionKey || doc.sequence >= sub.sequence) continue;
				if (doc.status === 'queued' || doc.status === 'running') {
					return null; // blocked by earlier unsettled submission
				}
			}

			const now = Date.now();
			const maxRetry = durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_RETRY;
			const timeoutAt = durability?.timeoutAt ?? (now + DURABILITY_DEFAULT_TIMEOUT_MINUTES * 60_000);

			const claimed: SubmissionDoc = {
				...sub,
				status: 'running',
				attemptId: attempt.attemptId,
				startedAt: now,
				attemptCount: 1,
				maxRetry,
				timeoutAt,
			};
			this.subs.putSync(attempt.submissionId, claimed);
			return docToSubmission(claimed);
		});
	}

	async markSubmissionInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (!sub || sub.status !== 'running' || sub.attemptId !== attempt.attemptId) return false;
			this.subs.putSync(attempt.submissionId, {
				...sub,
				inputAppliedAt: sub.inputAppliedAt ?? Date.now(),
			});
			return true;
		});
	}

	async requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (!sub || sub.status !== 'running' || sub.attemptId !== attempt.attemptId) return false;
			this.subs.putSync(attempt.submissionId, {
				...sub,
				recoveryRequestedAt: sub.recoveryRequestedAt ?? Date.now(),
			});
			return true;
		});
	}

	async requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (
				!sub ||
				sub.status !== 'running' ||
				sub.attemptId !== attempt.attemptId ||
				sub.inputAppliedAt !== null
			) {
				return false;
			}
			this.subs.putSync(attempt.submissionId, {
				...sub,
				status: 'queued',
				attemptId: null,
				recoveryRequestedAt: null,
				startedAt: null,
			});
			return true;
		});
	}

	async completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (!sub || sub.status !== 'running' || sub.attemptId !== attempt.attemptId) return false;
			this.subs.putSync(attempt.submissionId, {
				...sub,
				status: 'settled',
				settledAt: Date.now(),
				error: null,
			});
			return true;
		});
	}

	async failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return this.env.transactionSync(() => {
			const sub = this.subs.get(attempt.submissionId);
			if (!sub || sub.status !== 'running' || sub.attemptId !== attempt.attemptId) return false;
			this.subs.putSync(attempt.submissionId, {
				...sub,
				status: 'settled',
				settledAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
			return true;
		});
	}

	// ── Deletion ─────────────────────────────────────────────────────────

	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		return deduplicateSessionDeletion(this.pendingSessionDeletions, sessionKey, () =>
			this.runSessionDeletion(sessionKey, deleteSessionTree),
		);
	}

	// ── Private ──────────────────────────────────────────────────────────

	private admitSubmission(
		input: DispatchAgentSubmissionInput | DirectAgentSubmissionInput,
	): Promise<AgentDispatchAdmission> {
		const { kind, submissionId } = input;
		const payload = JSON.stringify(input);
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${kind} admission`);
		const sessionKey = createSessionStorageKey(input.id, 'default', input.session);

		return this.env.transaction(() => {
			// Check for retained receipt (dispatch replay after session deletion).
			if (kind === 'dispatch') {
				const receipt = this.receipts.get(submissionId);
				if (receipt) {
					return {
						kind: 'retained_receipt' as const,
						receipt: { submissionId, acceptedAt: receipt.acceptedAt },
					};
				}
			}

			// Block admission during session deletion.
			if (this.deletions.get(sessionKey)) {
				throw new Error(
					'[flue] Durable agent submission admission is unavailable while this session is being deleted. Retry after deletion completes.',
				);
			}

			// Idempotent insert: only create if not already present.
			const existing = this.subs.get(submissionId);
			if (existing) {
				if (existing.kind !== kind || existing.payload !== payload) {
					return { kind: 'conflict' as const };
				}
				return { kind: 'submission' as const, submission: docToSubmission(existing) };
			}

			const sequence = this.nextSequence();
			const doc: SubmissionDoc = {
				sequence,
				submissionId,
				sessionKey,
				kind,
				payload,
				status: 'queued',
				acceptedAt,
				attemptId: null,
				inputAppliedAt: null,
				recoveryRequestedAt: null,
				startedAt: null,
				settledAt: null,
				error: null,
				attemptCount: 0,
				maxRetry: DURABILITY_DEFAULT_MAX_RETRY,
				timeoutAt: 0,
			};
			this.subs.putSync(submissionId, doc);
			return { kind: 'submission' as const, submission: docToSubmission(doc) };
		});
	}

	private async runSessionDeletion(
		sessionKey: string,
		deleteSessionTree: () => Promise<void>,
	): Promise<void> {
		// Phase 1: check for active submissions and mark deletion.
		this.env.transactionSync(() => {
			for (const { value: doc } of this.subs.getRange()) {
				if (doc.sessionKey === sessionKey && (doc.status === 'queued' || doc.status === 'running')) {
					throw new Error(
						'[flue] Session cannot be deleted while durable agent submissions are queued or running. Wait for accepted work to settle, then retry deletion.',
					);
				}
			}
			if (!this.deletions.get(sessionKey)) {
				this.deletions.putSync(sessionKey, { startedAt: Date.now() });
			}
		});

		// Phase 2: delete the session tree (async, outside transaction).
		await deleteSessionTree();

		// Phase 3: clean up settled submission rows, preserve dispatch receipts.
		this.env.transactionSync(() => {
			for (const { value: doc } of this.subs.getRange()) {
				if (doc.sessionKey !== sessionKey || doc.status !== 'settled') continue;
				// Preserve dispatch receipt for idempotent replay.
				if (doc.kind === 'dispatch') {
					this.receipts.putSync(doc.submissionId, {
						acceptedAt: doc.acceptedAt,
						settledAt: doc.settledAt ?? doc.acceptedAt,
					});
				}
				this.subs.removeSync(doc.submissionId);
				this.journals.removeSync(doc.submissionId);
			}
			this.deletions.removeSync(sessionKey);
		});
	}

	private async failDocById(
		submissionId: string,
		status: 'queued' | 'active',
		error: unknown,
	): Promise<void> {
		const doc = this.subs.get(submissionId);
		if (!doc) return;
		const statusMatch = status === 'queued' ? doc.status === 'queued' : doc.status === 'running';
		if (statusMatch) {
			await this.subs.put(submissionId, {
				...doc,
				status: 'settled',
				settledAt: Date.now(),
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}
}

// ─── Document → interface converters ────────────────────────────────────────

function docToSubmission(doc: SubmissionDoc): AgentSubmission {
	// Validate status-specific invariants.
	if (
		(doc.status === 'queued' &&
			(doc.attemptId !== null || doc.inputAppliedAt !== null ||
			 doc.recoveryRequestedAt !== null || doc.startedAt !== null)) ||
		(doc.status === 'running' &&
			(doc.attemptId === null || doc.startedAt === null))
	) {
		throw new Error('[flue] Persisted agent submission document is malformed.');
	}

	const input = JSON.parse(doc.payload) as unknown;
	if (!isSubmissionPayload(input, {
		kind: doc.kind,
		submissionId: doc.submissionId,
		sessionKey: doc.sessionKey,
		acceptedAt: doc.acceptedAt,
	})) {
		throw new Error('[flue] Persisted agent submission payload is malformed.');
	}

	return {
		sequence: doc.sequence,
		submissionId: doc.submissionId,
		sessionKey: doc.sessionKey,
		kind: doc.kind,
		input,
		status: doc.status,
		acceptedAt: doc.acceptedAt,
		...(doc.attemptId !== null ? { attemptId: doc.attemptId } : {}),
		...(doc.inputAppliedAt !== null ? { inputAppliedAt: doc.inputAppliedAt } : {}),
		...(doc.recoveryRequestedAt !== null ? { recoveryRequestedAt: doc.recoveryRequestedAt } : {}),
		...(doc.startedAt !== null ? { startedAt: doc.startedAt } : {}),
		...(doc.error !== null ? { error: doc.error } : {}),
		attemptCount: doc.attemptCount,
		maxRetry: doc.maxRetry,
		timeoutAt: doc.timeoutAt,
	};
}

function docToJournal(doc: JournalDoc): AgentTurnJournal {
	return {
		submissionId: doc.submissionId,
		sessionKey: doc.sessionKey,
		kind: doc.kind,
		attemptId: doc.attemptId,
		operationId: doc.operationId,
		turnId: doc.turnId,
		phase: doc.phase,
		revision: doc.revision,
		createdAt: doc.createdAt,
		updatedAt: doc.updatedAt,
		...(doc.checkpointLeafId !== null ? { checkpointLeafId: doc.checkpointLeafId } : {}),
		...(doc.toolRequestJson !== null ? { toolRequest: JSON.parse(doc.toolRequestJson) as unknown } : {}),
		committed: doc.committed,
		...(doc.committedLeafId !== null ? { committedLeafId: doc.committedLeafId } : {}),
	};
}


