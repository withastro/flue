import type {
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionInput,
	AgentSubmissionStore,
	DispatchInput,
	PersistenceAdapter,
	SubmissionAttemptRef,
	SubmissionChunkRow,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	assertSupportedFlueSchemaVersion,
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	FLUE_SCHEMA_VERSION,
	hydratePersistedSubmissionAttachments,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	matchesPersistedSubmissionAttachments,
	parseAcceptedAt,
	prepareSubmissionAttachments,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
} from '@flue/runtime/adapter';
import { ulid } from 'ulidx';
import { RedisAttachmentStore } from './attachment-store.ts';
import { RedisConversationStreamStore } from './conversation-store.ts';
import { RedisKeys } from './redis-keys.ts';
import type { RedisArgument, RedisOptions, RedisRunner } from './redis-runner.ts';
import {
	acquireGenerationScript,
	admitSubmissionScript,
	claimJoinableSubmissionsScript,
	claimSubmissionScript,
	finalizeSettlementScript,
	joinLifecycleScript,
	lifecycleScript,
	markSubmissionCanonicalReadyScript,
	quarantineSubmissionScript,
	reclaimGenerationsScript,
	releaseGenerationScript,
	renewLeasesScript,
	repairSubmissionIndexesScript,
	replaceAttemptScript,
	reserveSettlementScript,
} from './redis-scripts.ts';

const empty = '';
const GENERATION_GRACE_MS = 60_000;

type Hash = Record<string, string>;

function strings(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.map(String);
}

function required(value: string | undefined, message: string): string {
	if (value === undefined) throw new TypeError(message);
	return value;
}

function hash(value: unknown): Hash {
	if (value == null) return {};
	if (!Array.isArray(value) && typeof value === 'object') {
		return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, String(entry)]));
	}
	const entries = strings(value);
	const result: Hash = {};
	for (let index = 0; index < entries.length; index += 2) {
		const key = entries[index];
		const entry = entries[index + 1];
		if (key === undefined || entry === undefined)
			throw new TypeError('Redis hash response is malformed.');
		result[key] = entry;
	}
	return result;
}

function integer(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed)) throw new TypeError('Persisted Redis integer is malformed.');
	return parsed;
}

function json(value: unknown): string {
	return JSON.stringify(value);
}

class Backend {
	constructor(
		readonly runner: RedisRunner,
		readonly keys: RedisKeys,
	) {}

	command(command: string, args: RedisArgument[] = []) {
		return this.runner.command(command, args);
	}

	eval(script: string, keys: string[], args: RedisArgument[] = []) {
		return this.runner.eval(script, keys, args);
	}

	async pipeline(commands: Array<{ command: string; args?: RedisArgument[] }>): Promise<unknown[]> {
		if (commands.length === 0) return [];
		if (!this.runner.pipeline) {
			const output: unknown[] = [];
			for (const item of commands) output.push(await this.command(item.command, item.args));
			return output;
		}
		const output = await this.runner.pipeline(commands);
		if (!Array.isArray(output) || output.length !== commands.length)
			throw new TypeError('Redis pipeline returned an invalid result shape.');
		for (const result of output) {
			if (result instanceof Error) throw result;
			if (Array.isArray(result) && result.length === 2 && result[0] instanceof Error)
				throw result[0];
		}
		return output;
	}

	async hgetall(key: string): Promise<Hash> {
		return hash(await this.command('HGETALL', [key]));
	}

	async zrange(key: string, start = 0, stop = -1, reverse = false): Promise<string[]> {
		return strings(await this.command(reverse ? 'ZREVRANGE' : 'ZRANGE', [key, start, stop]));
	}
}

export function redis(runner: RedisRunner, options: RedisOptions = {}): PersistenceAdapter {
	const backend = new Backend(runner, new RedisKeys(options.keyPrefix));
	let closed = false;
	return {
		async migrate() {
			await inspectServer(backend, options.inspectServer !== false);
			const stored = await backend.command('HGET', [backend.keys.meta(), 'schema_version']);
			if (stored == null) {
				let cursor = '0';
				let existing = false;
				do {
					const result = await backend.command('SCAN', [
						cursor,
						'MATCH',
						`${backend.keys.prefix}:*`,
						'COUNT',
						100,
					]);
					const page = Array.isArray(result) ? result : [];
					cursor = String(page[0] ?? '0');
					const keys = strings(page[1]);
					if (keys.some((key) => key !== backend.keys.meta())) existing = true;
				} while (cursor !== '0' && !existing);
				if (existing) assertSupportedFlueSchemaVersion('unversioned');
				await backend.command('HSETNX', [
					backend.keys.meta(),
					'schema_version',
					FLUE_SCHEMA_VERSION,
				]);
			} else assertSupportedFlueSchemaVersion(String(stored));
		},
		connect() {
			return {
				submissionStore: new RedisSubmissionStore(backend),
				conversationStreamStore: new RedisConversationStreamStore(runner, backend.keys),
				attachmentStore: new RedisAttachmentStore(runner, backend.keys),
			};
		},
		async close() {
			if (closed) return;
			closed = true;
			await runner.close();
		},
	};
}

async function inspectServer(backend: Backend, enabled: boolean): Promise<void> {
	if (!enabled) return;
	let clusterEnabled: boolean | undefined;
	try {
		// CONFIG GET replies are name/value pairs under RESP2 and a map under
		// RESP3; hash() normalizes both shapes.
		const cluster = hash(await backend.command('CONFIG', ['GET', 'cluster-enabled']));
		const value = cluster['cluster-enabled'];
		if (value === 'yes' || value === 'no') clusterEnabled = value === 'yes';
	} catch {}
	if (clusterEnabled === undefined) {
		try {
			const info = String(await backend.command('INFO', ['cluster']));
			if (/cluster_enabled:1/.test(info)) clusterEnabled = true;
			else if (/cluster_enabled:0/.test(info)) clusterEnabled = false;
		} catch {}
	}
	if (clusterEnabled === undefined)
		throw new TypeError('@flue/redis could not verify that Redis Cluster is disabled.');
	if (clusterEnabled) throw new TypeError('Redis Cluster is not supported by @flue/redis.');
	let policy: string | undefined;
	try {
		const memory = hash(await backend.command('CONFIG', ['GET', 'maxmemory-policy']));
		policy = memory['maxmemory-policy'];
	} catch {}
	if (!policy) {
		try {
			const info = String(await backend.command('INFO', ['memory']));
			policy = /^maxmemory_policy:(\S+)$/m.exec(info)?.[1];
		} catch {}
	}
	if (!policy) throw new TypeError('@flue/redis could not verify maxmemory-policy.');
	if (policy !== 'noeviction')
		throw new TypeError('@flue/redis requires maxmemory-policy noeviction.');
}

async function stageHash(
	backend: Backend,
	key: string,
	fields: Array<[string, string]>,
): Promise<void> {
	await backend.command('DEL', [key]);
	const commands = fields.map(([field, value]) => ({ command: 'HSET', args: [key, field, value] }));
	await backend.pipeline(commands);
}

async function reclaimGenerations(
	backend: Backend,
	pointer: string,
	readers: string,
	generations: string,
	generationKey: (generation: string) => string,
	force = false,
): Promise<void> {
	const removed = strings(
		await backend.eval(
			reclaimGenerationsScript,
			[pointer, readers, generations],
			[force ? Number.MAX_SAFE_INTEGER : Date.now() - GENERATION_GRACE_MS, 100],
		),
	);
	if (removed.length > 0) await backend.command('DEL', removed.map(generationKey));
}

async function readGeneration<T>(
	backend: Backend,
	pointer: string,
	readers: string,
	generationKey: (generation: string) => string,
	parse: (record: Hash) => T,
): Promise<T | null> {
	const acquired = strings(await backend.eval(acquireGenerationScript, [pointer, readers]));
	const generation = acquired[0];
	if (!generation) return null;
	try {
		return parse(await backend.hgetall(generationKey(generation)));
	} finally {
		await backend.eval(releaseGenerationScript, [readers], [generation]);
	}
}

class RedisSubmissionStore implements AgentSubmissionStore {
	constructor(private backend: Backend) {}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = await this.backend.hgetall(this.backend.keys.submission(submissionId));
		return row.submissionId ? this.parseSubmission(row) : null;
	}

	async markSubmissionCanonicalReady(submissionId: string): Promise<AgentSubmission | null> {
		const changed = integer(
			await this.backend.eval(
				markSubmissionCanonicalReadyScript,
				[this.backend.keys.submission(submissionId)],
				[Date.now()],
			),
		);
		return changed === 1 ? this.getSubmission(submissionId) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		for (const status of ['queued', 'running', 'terminalizing', 'joining', 'joined']) {
			if (
				integer(await this.backend.command('ZCARD', [this.backend.keys.submissionStatus(status)])) >
				0
			) {
				return true;
			}
		}
		return false;
	}

	async listUnreadySubmissions(): Promise<AgentSubmission[]> {
		const output: AgentSubmission[] = [];
		for (const id of await this.backend.zrange(this.backend.keys.submissionStatus('queued'))) {
			const submission = await this.readOperationalSubmission(id, 'queued');
			if (submission?.canonicalReadyAt === null) output.push(submission);
		}
		return output;
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const ids = await this.backend.zrange(this.backend.keys.submissionStatus('queued'));
		const output: AgentSubmission[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			const submission = await this.readOperationalSubmission(id, 'queued');
			if (submission && submission.canonicalReadyAt !== null && !seen.has(submission.sessionKey)) {
				seen.add(submission.sessionKey);
				const head = await this.findSessionHead(submission.sessionKey);
				if (head?.submissionId === id && head.status === 'queued') output.push(submission);
			}
		}
		return output;
	}

	async listRunningSubmissions(): Promise<AgentSubmission[]> {
		const output: AgentSubmission[] = [];
		for (const id of await this.backend.zrange(this.backend.keys.submissionStatus('running'))) {
			const submission = await this.readOperationalSubmission(id, 'running');
			if (submission) output.push(submission);
		}
		return output;
	}

	async replaceSubmissionAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		const updated =
			integer(
				await this.backend.eval(
					replaceAttemptScript,
					[this.backend.keys.submission(attempt.submissionId)],
					[
						attempt.attemptId,
						nextAttemptId,
						Date.now(),
						lease?.ownerId ?? empty,
						lease?.leaseExpiresAt ?? 0,
					],
				),
			) === 1;
		return updated ? this.getSubmission(attempt.submissionId) : null;
	}

	async admitDispatch(input: DispatchInput): Promise<AgentDispatchAdmission> {
		return this.admitSubmission(createDispatchAgentSubmissionInput(input));
	}

	async admitDirect(input: AgentSubmissionInput): Promise<AgentSubmission> {
		const admission = await this.admitSubmission(input);
		if (admission.kind !== 'submission')
			throw new TypeError('Internal direct admission returned an unexpected result.');
		return admission.submission;
	}

	async claimSubmission(claim: SubmissionClaimRef): Promise<AgentSubmission | null> {
		const row = await this.backend.hgetall(this.backend.keys.submission(claim.submissionId));
		if (!row.sessionKey) return null;
		const now = Date.now();
		try {
			const result = await this.backend.eval(
				claimSubmissionScript,
				[
					this.backend.keys.submission(claim.submissionId),
					this.backend.keys.sessionUnsettled(row.sessionKey),
					this.backend.keys.submissionStatus('queued'),
					this.backend.keys.submissionStatus('running'),
				],
				[
					empty,
					claim.attemptId,
					now,
					DURABILITY_DEFAULT_MAX_ATTEMPTS,
					claim.ownerId,
					claim.leaseExpiresAt,
					now + DURABILITY_DEFAULT_TIMEOUT_MS,
					claim.submissionId,
				],
			);
			return integer(result) === 1 ? this.getSubmission(claim.submissionId) : null;
		} finally {
			await this.repairSubmissionIndexes(claim.submissionId);
		}
	}

	markSubmissionInputApplied(
		attempt: SubmissionAttemptRef,
		durability?: { maxAttempts: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		return this.lifecycle(
			attempt,
			'input',
			now,
			durability?.maxAttempts ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
		);
	}

	requeueSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, 'requeue', Date.now());
	}

	async requestSessionAbort(sessionKey: string): Promise<string[]> {
		const ids = await this.backend.zrange(this.backend.keys.sessionUnsettled(sessionKey));
		const now = String(Date.now());
		const affected: string[] = [];
		for (const id of ids) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			if (
				row.status === 'queued' ||
				row.status === 'running' ||
				row.status === 'joining' ||
				row.status === 'joined'
			) {
				// COALESCE-equivalent: first abort request wins.
				await this.backend.command('HSETNX', [
					this.backend.keys.submission(id),
					'abortRequestedAt',
					now,
				]);
				affected.push(id);
			}
		}
		return affected;
	}

	async listPendingSubmissionSettlements(): Promise<
		import('@flue/runtime/adapter').SubmissionSettlementObligation[]
	> {
		const output: import('@flue/runtime/adapter').SubmissionSettlementObligation[] = [];
		for (const id of await this.backend.zrange(
			this.backend.keys.submissionStatus('terminalizing'),
		)) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			if (row.status === 'terminalizing')
				output.push({
					submissionId: id,
					sessionKey: required(row.sessionKey, 'Persisted Redis settlement session is missing.'),
					attemptId: required(row.attemptId, 'Persisted Redis settlement attempt is missing.'),
					recordId: required(
						row.settlementRecordId,
						'Persisted Redis settlement record id is missing.',
					),
					record: JSON.parse(
						required(row.settlementRecord, 'Persisted Redis settlement record is missing.'),
					),
				});
		}
		return output;
	}
	async reserveSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		settlement: {
			recordId: string;
			record: import('@flue/runtime/adapter').SubmissionSettledRecord;
		},
	): Promise<import('@flue/runtime/adapter').SubmissionSettlementObligation | null> {
		if (settlement.record.id !== settlement.recordId) return null;
		const id = attempt.submissionId;
		const row = await this.backend.hgetall(this.backend.keys.submission(id));
		if (!row.sessionKey) return null;
		// Two reservable shapes, for either submission kind: the submission's
		// own running attempt, or a delivery JOINED into a host running under
		// the caller's attempt. The host hash key is passed only when the
		// pre-read saw a join; the script re-verifies every mutable predicate
		// (status, joinedInto, host status/attempt) atomically before
		// adopting the row.
		const keys = [
			this.backend.keys.submission(id),
			this.backend.keys.submissionStatus('running'),
			this.backend.keys.submissionStatus('terminalizing'),
			this.backend.keys.sessionUnsettled(row.sessionKey),
			this.backend.keys.submissionStatus('joined'),
		];
		if (row.joinedInto) keys.push(this.backend.keys.submission(row.joinedInto));
		await this.backend.eval(reserveSettlementScript, keys, [
			attempt.attemptId,
			id,
			settlement.recordId,
			json(settlement.record),
			row.joinedInto ?? empty,
			Date.now(),
		]);
		const current = await this.backend.hgetall(this.backend.keys.submission(id));
		return current.status === 'terminalizing' &&
			current.sessionKey &&
			current.attemptId === attempt.attemptId &&
			current.settlementRecordId === settlement.recordId &&
			current.settlementRecord === json(settlement.record)
			? {
					submissionId: id,
					sessionKey: current.sessionKey,
					attemptId: attempt.attemptId,
					recordId: settlement.recordId,
					record: settlement.record,
				}
			: null;
	}
	async finalizeSubmissionSettlement(
		attempt: SubmissionAttemptRef,
		recordId: string,
		options?: { errorMessage?: string },
	): Promise<boolean> {
		const row = await this.backend.hgetall(this.backend.keys.submission(attempt.submissionId));
		if (!row.sessionKey) return false;
		// A host settles through the outbox; fan its outcome out to joined
		// deliveries the same way completeSubmission/failSubmission do. The
		// reserved record is immutable once terminalizing, so reading the
		// outcome ahead of the script is race-free. The durable settlement
		// record is the outcome authority; the row's error field mirrors it —
		// the caller's raw server-side message when provided, else the
		// record's client-safe one.
		const record = row.settlementRecord
			? (JSON.parse(row.settlementRecord) as { outcome?: string; error?: { message?: string } })
			: undefined;
		const errorMessage =
			record?.outcome === 'completed'
				? empty
				: (options?.errorMessage ?? record?.error?.message ?? 'The submission did not complete.');
		const joins = await this.listJoinIds(attempt.submissionId);
		return (
			integer(
				await this.backend.eval(
					finalizeSettlementScript,
					[
						this.backend.keys.submission(attempt.submissionId),
						this.backend.keys.submissionStatus('terminalizing'),
						this.backend.keys.sessionUnsettled(row.sessionKey),
						this.backend.keys.submissionStatus('queued'),
						this.backend.keys.submissionStatus('joining'),
						this.backend.keys.submissionStatus('joined'),
						this.backend.keys.submissionStatus('settled'),
						...joins.map((id) => this.backend.keys.submission(id)),
					],
					[
						attempt.submissionId,
						Date.now(),
						attempt.attemptId,
						recordId,
						errorMessage,
						empty,
						empty,
						...joins,
					],
				),
			) === 1
		);
	}

	completeSubmission(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, 'settle', Date.now(), empty);
	}

	failSubmission(attempt: SubmissionAttemptRef, error: unknown): Promise<boolean> {
		return this.lifecycle(
			attempt,
			'settle',
			Date.now(),
			error instanceof Error ? error.message : String(error),
		);
	}

	// ── Turn-boundary joins ──────────────────────────────────────────────

	async claimJoinableSubmissions(
		host: SubmissionAttemptRef,
		agentName: string,
	): Promise<AgentSubmission[]> {
		const hostRow = await this.backend.hgetall(this.backend.keys.submission(host.submissionId));
		if (
			!hostRow.sessionKey ||
			hostRow.status !== 'running' ||
			hostRow.attemptId !== host.attemptId
		) {
			return [];
		}
		// Pre-vet the queued prefix in admission order. Contiguous prefix: the
		// first non-joinable row ends the claim so admission order is preserved
		// (everything behind it stays queued). The agent-name predicate lives
		// in the immutable payload, so it is checked here; the claim script
		// atomically rechecks every mutable predicate before claiming a row.
		const candidates: AgentSubmission[] = [];
		for (const id of await this.backend.zrange(
			this.backend.keys.sessionUnsettled(hostRow.sessionKey),
		)) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			if (row.status !== 'queued') continue;
			if (!row.canonicalReadyAt || row.abortRequestedAt) break;
			const submission = await this.readOperationalSubmission(id, 'queued');
			if (!submission || submission.input.agent !== agentName) break;
			candidates.push(submission);
		}
		if (candidates.length === 0) return [];
		const claimed = new Set(
			strings(
				await this.backend.eval(
					claimJoinableSubmissionsScript,
					[
						this.backend.keys.submission(host.submissionId),
						this.backend.keys.submissionStatus('queued'),
						this.backend.keys.submissionStatus('joining'),
						...candidates.map((item) => this.backend.keys.submission(item.submissionId)),
					],
					[host.attemptId, host.submissionId, ...candidates.map((item) => item.submissionId)],
				),
			),
		);
		return candidates
			.filter((item) => claimed.has(item.submissionId))
			.map((item) => ({ ...item, status: 'joining' as const, joinedInto: host.submissionId }));
	}

	finalizeJoinedSubmission(host: SubmissionAttemptRef, submissionId: string): Promise<boolean> {
		return this.joinLifecycle(host, submissionId, 'finalize', 'joined');
	}

	revertJoiningSubmission(host: SubmissionAttemptRef, submissionId: string): Promise<boolean> {
		return this.joinLifecycle(host, submissionId, 'revert', 'queued');
	}

	async listJoinedSubmissions(hostSubmissionId: string): Promise<AgentSubmission[]> {
		const output: AgentSubmission[] = [];
		for (const id of await this.listJoinIds(hostSubmissionId)) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			if (row.status !== 'joining' && row.status !== 'joined') continue;
			const submission = await this.readOperationalSubmission(id, row.status);
			if (submission) output.push(submission);
		}
		return output;
	}

	private async joinLifecycle(
		host: SubmissionAttemptRef,
		submissionId: string,
		operation: 'finalize' | 'revert',
		targetStatus: 'joined' | 'queued',
	): Promise<boolean> {
		const result = await this.backend.eval(
			joinLifecycleScript,
			[
				this.backend.keys.submission(submissionId),
				this.backend.keys.submission(host.submissionId),
				this.backend.keys.submissionStatus('joining'),
				this.backend.keys.submissionStatus(targetStatus),
			],
			[operation, host.attemptId, host.submissionId, Date.now(), submissionId],
		);
		return integer(result) === 1;
	}

	/** Unsettled join ids attached to the host, in admission order. */
	private async listJoinIds(hostSubmissionId: string): Promise<string[]> {
		const output: Array<{ id: string; sequence: number }> = [];
		for (const status of ['joining', 'joined']) {
			for (const id of await this.backend.zrange(this.backend.keys.submissionStatus(status))) {
				const row = await this.backend.hgetall(this.backend.keys.submission(id));
				if (row.joinedInto !== hostSubmissionId || row.status !== status || !row.sequence) continue;
				output.push({ id, sequence: integer(row.sequence) });
			}
		}
		return output.sort((left, right) => left.sequence - right.sequence).map((item) => item.id);
	}

	async renewLeases(ownerId: string, submissionIds: string[]): Promise<void> {
		if (submissionIds.length === 0) return;
		await this.backend.eval(
			renewLeasesScript,
			submissionIds.map((id) => this.backend.keys.submission(id)),
			[ownerId, Date.now() + LEASE_DURATION_MS],
		);
	}

	async listExpiredSubmissions(): Promise<AgentSubmission[]> {
		const running = await this.listRunningSubmissions();
		const now = Date.now();
		return running.filter((item) => item.leaseExpiresAt > 0 && item.leaseExpiresAt < now);
	}

	private async admitSubmission(input: AgentSubmissionInput): Promise<AgentDispatchAdmission> {
		const prepared = prepareSubmissionAttachments(input);
		const generation = `gen_${ulid()}`;
		const generationKey = this.backend.keys.submissionGeneration(input.submissionId, generation);
		const sessionKey = createSessionStorageKey(
			input.agent,
			input.id,
			SUBMISSION_HARNESS_NAME,
			SUBMISSION_SESSION_NAME,
		);
		await this.backend.command('ZADD', [
			this.backend.keys.submissionGenerations(input.submissionId),
			Date.now(),
			generation,
		]);
		try {
			await stageHash(this.backend, generationKey, [
				['payload', json(prepared.value)],
				['chunkCount', String(prepared.chunks.length)],
				['sessionKey', sessionKey],
				...prepared.chunks.map(
					(chunk, index) => [`chunk:${index}`, json(chunk)] as [string, string],
				),
			]);
		} catch (error) {
			await this.backend.command('DEL', [generationKey]);
			throw error;
		}
		const acceptedAt = parseAcceptedAt(input.acceptedAt, `${input.kind} admission`);
		let result: string[];
		try {
			result = strings(
				await this.backend.eval(
					admitSubmissionScript,
					[
						generationKey,
						this.backend.keys.submission(input.submissionId),
						this.backend.keys.sequence(),
						this.backend.keys.submissionStatus('queued'),
						this.backend.keys.submissionGenerations(input.submissionId),
						this.backend.keys.sessionUnsettled(sessionKey),
					],
					[
						input.submissionId,
						sessionKey,
						input.kind,
						acceptedAt,
						DURABILITY_DEFAULT_MAX_ATTEMPTS,
						generation,
						Date.now(),
					],
				),
			);
		} catch (error) {
			if (
				integer(
					await this.backend.command('EXISTS', [this.backend.keys.submission(input.submissionId)]),
				) === 0
			) {
				await this.backend.pipeline([
					{
						command: 'ZREM',
						args: [this.backend.keys.submissionStatus('queued'), input.submissionId],
					},
					{
						command: 'ZREM',
						args: [this.backend.keys.sessionUnsettled(sessionKey), input.submissionId],
					},
				]);
			}
			throw error;
		}
		if (result[0] === 'created') {
			const submission = await this.getSubmission(input.submissionId);
			if (!submission) throw new TypeError('Redis admission created an unreadable submission.');
			await reclaimGenerations(
				this.backend,
				this.backend.keys.submission(input.submissionId),
				this.backend.keys.submissionReaders(input.submissionId),
				this.backend.keys.submissionGenerations(input.submissionId),
				(value) => this.backend.keys.submissionGeneration(input.submissionId, value),
			);
			return { kind: 'submission', submission };
		}
		await this.backend.command('DEL', [generationKey]);
		await this.backend.command('ZREM', [
			this.backend.keys.submissionGenerations(input.submissionId),
			generation,
		]);
		const existingRow = await this.backend.hgetall(
			this.backend.keys.submission(input.submissionId),
		);
		if (existingRow.sessionKey && existingRow.sessionKey !== sessionKey)
			return { kind: 'conflict' };
		const existing = await this.getSubmission(input.submissionId);
		if (!existing || existing.kind !== input.kind) return { kind: 'conflict' };
		const row = await this.backend.hgetall(this.backend.keys.submission(input.submissionId));
		const persistedGeneration = required(
			row.generation,
			'Persisted Redis submission generation is missing.',
		);
		const persisted = await this.readSubmissionGeneration(input.submissionId, persistedGeneration);
		if (
			!matchesPersistedSubmissionAttachments(
				input,
				JSON.parse(persisted.payload) as AgentSubmissionInput,
				persisted.chunks,
			)
		)
			return { kind: 'conflict' };
		return { kind: 'submission', submission: existing };
	}

	private async lifecycle(
		attempt: SubmissionAttemptRef,
		operation: string,
		value: RedisArgument,
		extra1: RedisArgument = empty,
		extra2: RedisArgument = empty,
	): Promise<boolean> {
		const id = attempt.submissionId;
		const row = await this.backend.hgetall(this.backend.keys.submission(id));
		if (!row.sessionKey) return false;
		// Settling a host fans its outcome out to joined deliveries; their row
		// keys ride along at KEYS[8..] with ids at the same ARGV index.
		const joins = operation === 'settle' ? await this.listJoinIds(id) : [];
		try {
			const result = await this.backend.eval(
				lifecycleScript,
				[
					this.backend.keys.submission(id),
					this.backend.keys.submissionStatus('queued'),
					this.backend.keys.submissionStatus('running'),
					this.backend.keys.submissionStatus('settled'),
					this.backend.keys.sessionUnsettled(row.sessionKey),
					this.backend.keys.submissionStatus('joining'),
					this.backend.keys.submissionStatus('joined'),
					...joins.map((join) => this.backend.keys.submission(join)),
				],
				['running', attempt.attemptId, operation, value, extra1, extra2, id, ...joins],
			);
			return integer(result) === 1;
		} finally {
			await this.repairSubmissionIndexes(id);
		}
	}

	private async repairSubmissionIndexes(id: string): Promise<void> {
		// sessionKey is immutable once the row exists, so pre-reading it to
		// name the unsettled zset is race-free; every mutable field (status,
		// sequence) is read inside the script, atomically with the rewrite.
		const sessionKey = await this.backend.command('HGET', [
			this.backend.keys.submission(id),
			'sessionKey',
		]);
		if (sessionKey == null) return;
		await this.backend.eval(
			repairSubmissionIndexesScript,
			[
				this.backend.keys.submission(id),
				this.backend.keys.submissionStatus('queued'),
				this.backend.keys.submissionStatus('running'),
				this.backend.keys.submissionStatus('terminalizing'),
				this.backend.keys.submissionStatus('settled'),
				this.backend.keys.submissionStatus('joining'),
				this.backend.keys.submissionStatus('joined'),
				this.backend.keys.sessionUnsettled(String(sessionKey)),
			],
			[id],
		);
	}

	private async findSessionHead(sessionKey: string): Promise<AgentSubmission | null> {
		const ids = await this.backend.zrange(this.backend.keys.sessionUnsettled(sessionKey));
		for (const id of ids) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			// An unsettled non-claimable head (terminalizing, or a join clearing
			// with its host) blocks the session without being runnable itself.
			if (row.status === 'terminalizing' || row.status === 'joining' || row.status === 'joined')
				return null;
			const status = row.status === 'running' ? 'running' : 'queued';
			const value = await this.readOperationalSubmission(id, status);
			if (value) return value;
		}
		return null;
	}

	private async readOperationalSubmission(
		id: string,
		expectedStatus: 'queued' | 'running' | 'joining' | 'joined',
	): Promise<AgentSubmission | null> {
		let submission: AgentSubmission | null;
		try {
			submission = await this.getSubmission(id);
		} catch (error) {
			// The row exists but does not parse — genuine corruption, the only
			// case quarantine may claim: it force-settles the row and strips it
			// from every index.
			await this.quarantineSubmission(id, error);
			return null;
		}
		// A missing row, or a status other than the index entry the caller was
		// iterating, is read-side concurrency: a peer's atomic transition moved
		// the id on between the ZRANGE and this read. The row is the authority
		// and stays live — skip the id.
		if (!submission || submission.status !== expectedStatus) return null;
		return submission;
	}

	private async quarantineSubmission(id: string, error: unknown): Promise<void> {
		const row = await this.backend.hgetall(this.backend.keys.submission(id));
		const sessionKey = row.sessionKey ?? empty;
		// A quarantined running host can have joined deliveries gated on its
		// attempt; their row keys ride along at KEYS[8..] with ids at the same
		// ARGV index so the script fans the outcome out to them.
		const joins = await this.listJoinIds(id);
		await this.backend.eval(
			quarantineSubmissionScript,
			[
				this.backend.keys.submission(id),
				this.backend.keys.submissionStatus('queued'),
				this.backend.keys.submissionStatus('running'),
				this.backend.keys.submissionStatus('joining'),
				this.backend.keys.submissionStatus('joined'),
				this.backend.keys.sessionUnsettled(sessionKey),
				this.backend.keys.submissionStatus('settled'),
				...joins.map((joinId) => this.backend.keys.submission(joinId)),
			],
			[
				id,
				row.sequence ?? 0,
				Date.now(),
				error instanceof Error ? error.message : String(error),
				empty,
				empty,
				empty,
				...joins,
			],
		);
	}

	private async readSubmissionGeneration(
		submissionId: string,
		generation?: string,
	): Promise<{ payload: string; chunks: SubmissionChunkRow[] }> {
		const parse = (record: Hash) => {
			if (!record.payload)
				throw new TypeError('Persisted Redis submission generation is malformed.');
			const chunks: SubmissionChunkRow[] = [];
			for (let index = 0; index < integer(record.chunkCount ?? 0); index++) {
				const chunk = record[`chunk:${index}`];
				if (!chunk) throw new TypeError('Persisted Redis submission generation is malformed.');
				chunks.push(JSON.parse(chunk));
			}
			return { payload: record.payload, chunks };
		};
		if (generation)
			return parse(
				await this.backend.hgetall(
					this.backend.keys.submissionGeneration(submissionId, generation),
				),
			);
		const value = await readGeneration(
			this.backend,
			this.backend.keys.submission(submissionId),
			this.backend.keys.submissionReaders(submissionId),
			(item) => this.backend.keys.submissionGeneration(submissionId, item),
			parse,
		);
		if (!value) throw new TypeError('Persisted Redis submission generation is missing.');
		return value;
	}

	private async parseSubmission(row: Hash): Promise<AgentSubmission> {
		const malformed = 'Persisted Redis submission payload is malformed.';
		const submissionId = required(row.submissionId, malformed);
		const sessionKey = required(row.sessionKey, malformed);
		const kind = required(row.kind, malformed) as 'dispatch' | 'direct';
		const persisted = await this.readSubmissionGeneration(submissionId);
		const acceptedAt = integer(row.acceptedAt);
		const parsed = JSON.parse(persisted.payload) as AgentSubmissionInput;
		const input = hydratePersistedSubmissionAttachments(parsed, persisted.chunks);
		if (!isSubmissionPayload(input, { kind, submissionId, sessionKey, acceptedAt }))
			throw new TypeError(malformed);
		return {
			sequence: integer(row.sequence),
			submissionId,
			sessionKey,
			kind,
			input,
			status: row.status as AgentSubmission['status'],
			acceptedAt,
			canonicalReadyAt: row.canonicalReadyAt ? integer(row.canonicalReadyAt) : null,
			...(row.attemptId ? { attemptId: row.attemptId } : {}),
			...(row.inputAppliedAt ? { inputAppliedAt: integer(row.inputAppliedAt) } : {}),
			...(row.abortRequestedAt ? { abortRequestedAt: integer(row.abortRequestedAt) } : {}),
			...(row.startedAt ? { startedAt: integer(row.startedAt) } : {}),
			...(row.joinedInto ? { joinedInto: row.joinedInto } : {}),
			...(row.error ? { error: row.error } : {}),
			...(row.settledAt != null ? { settledAt: integer(row.settledAt) } : {}),
			attemptCount: integer(row.attemptCount),
			maxAttempts: integer(row.maxAttempts),
			timeoutAt: integer(row.timeoutAt),
			...(row.ownerId ? { ownerId: row.ownerId } : {}),
			leaseExpiresAt: integer(row.leaseExpiresAt),
		};
	}
}
