import { randomUUID } from 'node:crypto';
import type { WorkflowRunPointer } from '@flue/runtime';
import type {
	AgentAttemptMarker,
	AgentDispatchAdmission,
	AgentSubmission,
	AgentSubmissionStore,
	AgentTurnJournal,
	AgentTurnJournalPhase,
	CreateRunInput,
	CreateTurnJournalInput,
	DirectAgentSubmissionInput,
	DispatchAgentSubmissionInput,
	DispatchInput,
	EndRunInput,
	EventStreamMeta,
	EventStreamReadResult,
	EventStreamStore,
	ListRunsOpts,
	ListRunsResponse,
	PersistedChunkOwner,
	PersistedChunkRow,
	PersistedChunkStore,
	PersistenceAdapter,
	RunPointer,
	RunRecord,
	RunStatus,
	SessionData,
	SessionEntry,
	SessionStore,
	SubmissionAttemptRef,
	SubmissionClaimRef,
} from '@flue/runtime/adapter';
import {
	assertSupportedFlueSchemaVersion,
	clampLimit,
	createDispatchAgentSubmissionInput,
	createSessionStorageKey,
	DEFAULT_LIST_LIMIT,
	DEFAULT_READ_LIMIT,
	DURABILITY_DEFAULT_MAX_ATTEMPTS,
	DURABILITY_DEFAULT_TIMEOUT_MS,
	decodeRunCursor,
	deduplicateSessionDeletion,
	encodeRunCursor,
	FLUE_SCHEMA_VERSION,
	formatOffset,
	hydratePersistedDirectSubmission,
	hydratePersistedSessionEntry,
	isSubmissionPayload,
	LEASE_DURATION_MS,
	MAX_LIST_LIMIT,
	MAX_READ_LIMIT,
	matchesPersistedDirectSubmission,
	parseAcceptedAt,
	parseOffset,
	prepareDirectSubmission,
	prepareSessionEntry,
	SUBMISSION_HARNESS_NAME,
	SUBMISSION_SESSION_NAME,
	submissionChunkOwner,
} from '@flue/runtime/adapter';
import {
	RedisConversationSnapshotStore,
	RedisConversationStreamStore,
} from './conversation-store.ts';
import { encodeSegment, RedisKeys } from './redis-keys.ts';
import type { RedisArgument, RedisOptions, RedisRunner } from './redis-runner.ts';
import {
	acquireDeletionScript,
	acquireGenerationScript,
	admitSubmissionScript,
	appendEventOnceScript,
	appendEventScript,
	claimSubmissionScript,
	closeEventScript,
	createRunScript,
	deleteSubmissionScript,
	endRunScript,
	finalizeTerminalScript,
	finishDeletionScript,
	journalScript,
	lifecycleScript,
	prepareTerminalScript,
	publishChunksScript,
	publishGenerationScript,
	quarantineSubmissionScript,
	reclaimGenerationsScript,
	recordTerminalOffsetScript,
	releaseGenerationScript,
	renewDeletionScript,
	renewLeasesScript,
	replaceAttemptScript,
} from './redis-scripts.ts';

const empty = '';
const GENERATION_GRACE_MS = 60_000;
const DELETION_LEASE_MS = 30_000;
const DELETION_POLL_MS = 50;

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

function optionalJson(value: unknown): string {
	return value === undefined ? empty : json(value);
}

function score(startedAt: string): number {
	const value = Date.parse(startedAt);
	if (!Number.isFinite(value)) throw new TypeError('Run startedAt must be a valid timestamp.');
	return value;
}

function canonicalStartedAt(startedAt: string): string {
	return new Date(score(startedAt)).toISOString();
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
			const stored = await backend.command('HGET', [backend.keys.meta(), 'schemaVersion']);
			if (stored == null)
				await backend.command('HSETNX', [
					backend.keys.meta(),
					'schemaVersion',
					FLUE_SCHEMA_VERSION,
				]);
			else assertSupportedFlueSchemaVersion(String(stored));
		},
		connect() {
			return {
				executionStore: {
					sessions: new RedisSessionStore(backend),
					submissions: new RedisSubmissionStore(backend),
				},
				runStore: new RedisRunStore(backend),
				eventStreamStore: new RedisEventStreamStore(backend),
				conversationStreamStore: new RedisConversationStreamStore(runner, backend.keys),
				conversationSnapshotStore: new RedisConversationSnapshotStore(runner, backend.keys),
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
		const cluster = strings(await backend.command('CONFIG', ['GET', 'cluster-enabled']));
		if (cluster[1] === 'yes' || cluster[1] === 'no') clusterEnabled = cluster[1] === 'yes';
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
		const memory = strings(await backend.command('CONFIG', ['GET', 'maxmemory-policy']));
		policy = memory[1];
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

class RedisSessionStore implements SessionStore {
	constructor(private backend: Backend) {}

	async save(id: string, data: SessionData): Promise<void> {
		const generation = randomUUID();
		const generationKey = this.backend.keys.sessionGeneration(id, generation);
		await this.backend.command('ZADD', [
			this.backend.keys.sessionGenerations(id),
			Date.now(),
			generation,
		]);
		const { entries, ...session } = data;
		const fields: Array<[string, string]> = [
			['session', json(session)],
			['entryCount', String(entries.length)],
		];
		for (const [index, entry] of entries.entries()) {
			const prepared = prepareSessionEntry(entry);
			fields.push([
				`entry:${index}`,
				json({ id: entry.id, value: prepared.value, chunks: prepared.chunks }),
			]);
		}
		try {
			await stageHash(this.backend, generationKey, fields);
		} catch (error) {
			await this.backend.command('DEL', [generationKey]);
			throw error;
		}
		const pointer = this.backend.keys.session(id);
		const generations = this.backend.keys.sessionGenerations(id);
		await this.backend.eval(
			publishGenerationScript,
			[pointer, generationKey, generations],
			[generation, Date.now()],
		);
		await reclaimGenerations(
			this.backend,
			pointer,
			this.backend.keys.sessionReaders(id),
			generations,
			(value) => this.backend.keys.sessionGeneration(id, value),
		);
	}

	async load(id: string): Promise<SessionData | null> {
		return readGeneration(
			this.backend,
			this.backend.keys.session(id),
			this.backend.keys.sessionReaders(id),
			(value) => this.backend.keys.sessionGeneration(id, value),
			(record) => {
				if (!record.session)
					throw new TypeError('Persisted Redis session generation is malformed.');
				const session = JSON.parse(record.session) as Omit<SessionData, 'entries'>;
				const entries = [];
				for (let index = 0; index < integer(record.entryCount); index++) {
					const raw = record[`entry:${index}`];
					if (!raw) throw new TypeError('Persisted Redis session entry is malformed.');
					const entry = JSON.parse(raw) as { value: SessionEntry; chunks: PersistedChunkRow[] };
					entries.push(hydratePersistedSessionEntry(entry.value, entry.chunks));
				}
				return { ...session, entries };
			},
		);
	}

	async delete(id: string): Promise<void> {
		const generations = this.backend.keys.sessionGenerations(id);
		await this.backend.command('HDEL', [this.backend.keys.session(id), 'generation']);
		await reclaimGenerations(
			this.backend,
			this.backend.keys.session(id),
			this.backend.keys.sessionReaders(id),
			generations,
			(value) => this.backend.keys.sessionGeneration(id, value),
			true,
		);
		await this.backend.command('DEL', [
			this.backend.keys.session(id),
			generations,
			this.backend.keys.sessionReaders(id),
		]);
	}
}

function createChunkStore(backend: Backend): PersistedChunkStore<Promise<void>> {
	return {
		async read(owner) {
			return (
				(await readGeneration(
					backend,
					backend.keys.chunkOwner(owner),
					backend.keys.chunkReaders(owner),
					(value) => backend.keys.chunkGeneration(owner, value),
					(record) => {
						const count = integer(record.count ?? 0);
						const rows: PersistedChunkRow[] = [];
						for (let index = 0; index < count; index++) {
							const value = record[`chunk:${index}`];
							if (!value) throw new TypeError('Persisted Redis image chunk is malformed.');
							rows.push(JSON.parse(value));
						}
						return rows;
					},
				)) ?? []
			);
		},
		async replace(owner, chunks) {
			const generation = randomUUID();
			const generationKey = backend.keys.chunkGeneration(owner, generation);
			const pointer = backend.keys.chunkOwner(owner);
			const generations = `${pointer}:generations`;
			await backend.command('ZADD', [generations, Date.now(), generation]);
			try {
				await stageHash(backend, generationKey, [
					['count', String(chunks.length)],
					...chunks.map((chunk, index) => [`chunk:${index}`, json(chunk)] as [string, string]),
				]);
			} catch (error) {
				await backend.command('DEL', [generationKey]);
				throw error;
			}
			await backend.eval(
				publishChunksScript,
				[pointer, generationKey, generations, backend.keys.chunkOwners()],
				[generation, Date.now()],
			);
			await reclaimGenerations(
				backend,
				pointer,
				backend.keys.chunkReaders(owner),
				generations,
				(value) => backend.keys.chunkGeneration(owner, value),
			);
		},
		async delete(owner) {
			await deleteChunkOwner(backend, owner);
		},
		async deleteMany(owners) {
			for (const owner of owners) await deleteChunkOwner(backend, owner);
		},
		async deleteOwner(kind, id) {
			const pointers = strings(await backend.command('SMEMBERS', [backend.keys.chunkOwners()]));
			const prefix = backend.keys.encoded('chunk-owner', kind, id);
			for (const pointer of pointers.filter((value) => value.startsWith(`${prefix}:`)))
				await deleteChunkPointer(backend, pointer);
		},
	};
}

async function deleteChunkOwner(backend: Backend, owner: PersistedChunkOwner): Promise<void> {
	await deleteChunkPointer(backend, backend.keys.chunkOwner(owner), owner);
}

async function deleteChunkPointer(
	backend: Backend,
	pointer: string,
	owner?: PersistedChunkOwner,
): Promise<void> {
	const generations = `${pointer}:generations`;
	const values = strings(await backend.command('ZRANGE', [generations, 0, -1]));
	if (values.length > 0) {
		let resolvedOwner = owner;
		if (!resolvedOwner) {
			const parts = pointer
				.split(':')
				.slice(-3)
				.map((part) => Buffer.from(part, 'base64url').toString());
			const kind = parts[0];
			const id = parts[1];
			const part = parts[2];
			if (!kind || !id || !part) throw new TypeError('Persisted Redis chunk owner is malformed.');
			resolvedOwner = { kind: kind as PersistedChunkOwner['kind'], id, part };
		}
		await backend.command(
			'DEL',
			values.map((value) => backend.keys.chunkGeneration(resolvedOwner, value)),
		);
	}
	await backend.command('DEL', [pointer, generations]);
	await backend.command('SREM', [backend.keys.chunkOwners(), pointer]);
}

class RedisSubmissionStore implements AgentSubmissionStore {
	private pendingSessionDeletions = new Map<string, Promise<void>>();
	private chunks: PersistedChunkStore<Promise<void>>;

	constructor(private backend: Backend) {
		this.chunks = createChunkStore(backend);
	}

	async getSubmission(submissionId: string): Promise<AgentSubmission | null> {
		const row = await this.backend.hgetall(this.backend.keys.submission(submissionId));
		return row.submissionId ? this.parseSubmission(row) : null;
	}

	async getTurnJournal(submissionId: string): Promise<AgentTurnJournal | null> {
		const row = await this.backend.hgetall(this.backend.keys.journal(submissionId));
		return row.submissionId ? parseJournal(row) : null;
	}

	async hasUnsettledSubmissions(): Promise<boolean> {
		return (
			integer(await this.backend.command('ZCARD', [this.backend.keys.submissionStatus('queued')])) >
				0 ||
			integer(
				await this.backend.command('ZCARD', [this.backend.keys.submissionStatus('running')]),
			) > 0 ||
			integer(
				await this.backend.command('ZCARD', [this.backend.keys.submissionStatus('terminalizing')]),
			) > 0
		);
	}

	async listRunnableSubmissions(): Promise<AgentSubmission[]> {
		const ids = await this.backend.zrange(this.backend.keys.submissionStatus('queued'));
		const output: AgentSubmission[] = [];
		const seen = new Set<string>();
		for (const id of ids) {
			const submission = await this.readOperationalSubmission(id, 'queued');
			if (submission && !seen.has(submission.sessionKey)) {
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

	async beginTurnJournal(input: CreateTurnJournalInput): Promise<boolean> {
		const now = Date.now();
		return (
			integer(
				await this.backend.eval(
					journalScript,
					[this.backend.keys.journal(input.submissionId), this.backend.keys.journals()],
					[
						'begin',
						input.submissionId,
						input.sessionKey,
						input.kind,
						input.attemptId,
						input.operationId,
						input.turnId,
						input.phase,
						now,
						input.checkpointLeafId ?? empty,
						optionalJson(input.toolRequest),
					],
				),
			) === 1
		);
	}

	async updateTurnJournalPhase(
		attempt: SubmissionAttemptRef,
		phase: AgentTurnJournalPhase,
		options: { checkpointLeafId?: string; toolRequest?: unknown; streamKey?: string } = {},
	): Promise<boolean> {
		return (
			integer(
				await this.backend.eval(
					journalScript,
					[this.backend.keys.journal(attempt.submissionId)],
					[
						'phase',
						attempt.attemptId,
						phase,
						Date.now(),
						options.checkpointLeafId ?? empty,
						optionalJson(options.toolRequest),
						options.streamKey ?? empty,
					],
				),
			) === 1
		);
	}

	async commitTurnJournal(
		attempt: SubmissionAttemptRef,
		committedLeafId: string,
	): Promise<boolean> {
		return (
			integer(
				await this.backend.eval(
					journalScript,
					[this.backend.keys.journal(attempt.submissionId)],
					['commit', attempt.attemptId, Date.now(), committedLeafId],
				),
			) === 1
		);
	}

	async markStreamConsumed(attempt: SubmissionAttemptRef, streamKey: string): Promise<boolean> {
		return (
			integer(
				await this.backend.eval(
					journalScript,
					[this.backend.keys.journal(attempt.submissionId)],
					['consumed', attempt.attemptId, streamKey, Date.now()],
				),
			) === 1
		);
	}

	async appendStreamChunkSegment(
		streamKey: string,
		segmentIndex: number,
		body: string,
	): Promise<boolean> {
		const inserted =
			integer(
				await this.backend.command('HSETNX', [
					this.backend.keys.streamSegments(streamKey),
					String(segmentIndex),
					body,
				]),
			) === 1;
		if (inserted)
			await this.backend.command('SADD', [this.backend.keys.streamSegmentKeys(), streamKey]);
		return inserted;
	}

	async getStreamChunkSegments(
		streamKey: string,
	): Promise<Array<{ segmentIndex: number; body: string }>> {
		const row = await this.backend.hgetall(this.backend.keys.streamSegments(streamKey));
		return Object.entries(row)
			.map(([index, body]) => ({ segmentIndex: integer(index), body }))
			.sort((a, b) => a.segmentIndex - b.segmentIndex);
	}

	async deleteStreamChunkSegments(streamKey: string): Promise<void> {
		await this.backend.command('DEL', [this.backend.keys.streamSegments(streamKey)]);
		await this.backend.command('SREM', [this.backend.keys.streamSegmentKeys(), streamKey]);
	}

	async replaceTurnJournalAttempt(
		attempt: SubmissionAttemptRef,
		nextAttemptId: string,
		lease?: { ownerId: string; leaseExpiresAt: number },
	): Promise<AgentSubmission | null> {
		const updated =
			integer(
				await this.backend.eval(
					replaceAttemptScript,
					[
						this.backend.keys.submission(attempt.submissionId),
						this.backend.keys.journal(attempt.submissionId),
					],
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

	async admitDirect(input: DirectAgentSubmissionInput): Promise<AgentSubmission> {
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
		durability?: { maxRetry: number; timeoutAt: number },
	): Promise<boolean> {
		const now = Date.now();
		return this.lifecycle(
			attempt,
			'input',
			now,
			durability?.maxRetry ?? DURABILITY_DEFAULT_MAX_ATTEMPTS,
			durability?.timeoutAt ?? now + DURABILITY_DEFAULT_TIMEOUT_MS,
		);
	}

	requestSubmissionRecovery(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, 'recovery', Date.now());
	}

	requeueSubmissionBeforeInputApplied(attempt: SubmissionAttemptRef): Promise<boolean> {
		return this.lifecycle(attempt, 'requeue', Date.now());
	}

	async listPendingTerminalOutboxes(): Promise<any[]> {
		const output = [];
		for (const id of await this.backend.zrange(this.backend.keys.submissionStatus('terminalizing'))) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			if (row.kind === 'direct' && row.status === 'terminalizing') output.push({ submissionId: id, sessionKey: required(row.sessionKey, 'Persisted Redis terminal session is missing.'), attemptId: required(row.attemptId, 'Persisted Redis terminal attempt is missing.'), eventKey: required(row.terminalKey, 'Persisted Redis terminal key is missing.'), event: JSON.parse(required(row.terminalEvent, 'Persisted Redis terminal event is missing.')), ...(row.terminalOffset ? { offset: row.terminalOffset } : {}) });
		}
		return output;
	}
	async reserveSubmissionTerminal(attempt: SubmissionAttemptRef, terminal: { eventKey: string; event: unknown }): Promise<any | null> {
		const id = attempt.submissionId;
		const row = await this.backend.hgetall(this.backend.keys.submission(id));
		if (!row.sessionKey) return null;
		await this.backend.eval(prepareTerminalScript, [this.backend.keys.submission(id), this.backend.keys.submissionStatus('running'), this.backend.keys.submissionStatus('terminalizing'), this.backend.keys.sessionUnsettled(row.sessionKey)], [attempt.attemptId, id, terminal.eventKey, json(terminal.event)]);
		const current = await this.backend.hgetall(this.backend.keys.submission(id));
		return current.status === 'terminalizing' && current.attemptId === attempt.attemptId && current.terminalKey === terminal.eventKey && current.terminalEvent === json(terminal.event) ? { submissionId: id, sessionKey: current.sessionKey, attemptId: attempt.attemptId, eventKey: terminal.eventKey, event: terminal.event, ...(current.terminalOffset ? { offset: current.terminalOffset } : {}) } : null;
	}
	async recordSubmissionTerminalOffset(attempt: SubmissionAttemptRef, eventKey: string, offset: string): Promise<boolean> {
		return integer(await this.backend.eval(recordTerminalOffsetScript, [this.backend.keys.submission(attempt.submissionId)], [attempt.attemptId, eventKey, offset])) === 1;
	}
	async finalizeSubmissionTerminal(attempt: SubmissionAttemptRef, eventKey: string): Promise<boolean> {
		const row = await this.backend.hgetall(this.backend.keys.submission(attempt.submissionId));
		if (!row.sessionKey || row.attemptId !== attempt.attemptId || row.terminalKey !== eventKey || !row.terminalOffset) return false;
		return integer(await this.backend.eval(finalizeTerminalScript, [this.backend.keys.submission(attempt.submissionId), this.backend.keys.submissionStatus('terminalizing'), this.backend.keys.sessionUnsettled(row.sessionKey)], [attempt.submissionId, Date.now(), row.terminalOffset])) === 1;
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

	async insertAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		const member = `${encodeSegment(attempt.submissionId)}.${encodeSegment(attempt.attemptId)}`;
		await this.backend.command('HSETNX', [
			this.backend.keys.marker(attempt.submissionId, attempt.attemptId),
			'createdAt',
			Date.now(),
		]);
		await this.backend.command('SADD', [this.backend.keys.markers(), member]);
	}

	async deleteAttemptMarker(attempt: SubmissionAttemptRef): Promise<void> {
		const member = `${encodeSegment(attempt.submissionId)}.${encodeSegment(attempt.attemptId)}`;
		await this.backend.command('DEL', [
			this.backend.keys.marker(attempt.submissionId, attempt.attemptId),
		]);
		await this.backend.command('SREM', [this.backend.keys.markers(), member]);
	}

	async listAttemptMarkers(): Promise<AgentAttemptMarker[]> {
		const members = strings(await this.backend.command('SMEMBERS', [this.backend.keys.markers()]));
		const output: AgentAttemptMarker[] = [];
		for (const member of members) {
			const [submission, attempt] = member.split('.');
			if (!submission || !attempt) continue;
			const submissionId = Buffer.from(submission, 'base64url').toString();
			const attemptId = Buffer.from(attempt, 'base64url').toString();
			const createdAt = await this.backend.command('HGET', [
				this.backend.keys.marker(submissionId, attemptId),
				'createdAt',
			]);
			if (createdAt != null)
				output.push({ submissionId, attemptId, createdAt: integer(createdAt) });
		}
		return output;
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

	deleteSession(sessionKey: string, deleteSessionTree: () => Promise<void>): Promise<void> {
		return deduplicateSessionDeletion(this.pendingSessionDeletions, sessionKey, () =>
			this.runSessionDeletion(sessionKey, deleteSessionTree),
		);
	}

	async listPendingSessionDeletions(): Promise<string[]> {
		return strings(await this.backend.command('ZRANGE', [this.backend.keys.deletions(), 0, -1]));
	}

	private async admitSubmission(
		input: DispatchAgentSubmissionInput | DirectAgentSubmissionInput,
	): Promise<AgentDispatchAdmission> {
		const prepared =
			input.kind === 'direct' ? prepareDirectSubmission(input) : { value: input, chunks: [] };
		const generation = randomUUID();
		const generationKey = this.backend.keys.submissionGeneration(input.submissionId, generation);
		const sessionKey = createSessionStorageKey(
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
		if (
			integer(await this.backend.command('EXISTS', [this.backend.keys.deletion(sessionKey)])) === 1
		) {
			await this.backend.command('DEL', [generationKey]);
			await this.backend.command('ZREM', [
				this.backend.keys.submissionGenerations(input.submissionId),
				generation,
			]);
			throw new TypeError(
				'Durable agent submission admission is unavailable while this session is being deleted.',
			);
		}
		let result: string[];
		try {
			result = strings(
				await this.backend.eval(
					admitSubmissionScript,
					[
						generationKey,
						this.backend.keys.submission(input.submissionId),
						this.backend.keys.sequence(),
						this.backend.keys.submissionIds(),
						this.backend.keys.submissionOrder(),
						this.backend.keys.submissionStatus('queued'),
						this.backend.keys.sessionSubmissions(sessionKey),
						this.backend.keys.submissionGenerations(input.submissionId),
						this.backend.keys.receipt(input.submissionId),
						this.backend.keys.deletion(sessionKey),
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
					{ command: 'ZREM', args: [this.backend.keys.submissionIds(), input.submissionId] },
					{ command: 'ZREM', args: [this.backend.keys.submissionOrder(), input.submissionId] },
					{
						command: 'ZREM',
						args: [this.backend.keys.submissionStatus('queued'), input.submissionId],
					},
					{
						command: 'ZREM',
						args: [this.backend.keys.sessionSubmissions(sessionKey), input.submissionId],
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
		if (result[0] === 'receipt')
			return {
				kind: 'retained_receipt',
				receipt: { submissionId: input.submissionId, acceptedAt: integer(result[1]) },
			};
		if (result[0] === 'deleting')
			throw new TypeError(
				'Durable agent submission admission is unavailable while this session is being deleted.',
			);
		const existingRow = await this.backend.hgetall(
			this.backend.keys.submission(input.submissionId),
		);
		if (existingRow.sessionKey && existingRow.sessionKey !== sessionKey)
			return { kind: 'conflict' };
		const existing = await this.getSubmission(input.submissionId);
		if (!existing || existing.kind !== input.kind) return { kind: 'conflict' };
		if (input.kind === 'direct') {
			const row = await this.backend.hgetall(this.backend.keys.submission(input.submissionId));
			const generation = required(
				row.generation,
				'Persisted Redis submission generation is missing.',
			);
			const persisted = await this.readSubmissionGeneration(input.submissionId, generation);
			if (
				!matchesPersistedDirectSubmission(
					input,
					JSON.parse(persisted.payload) as DirectAgentSubmissionInput,
					persisted.chunks,
				)
			)
				return { kind: 'conflict' };
		} else if (json(existing.input) !== json(input)) return { kind: 'conflict' };
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
		try {
			const result = await this.backend.eval(
				lifecycleScript,
				[
					this.backend.keys.submission(id),
					this.backend.keys.submissionStatus('queued'),
					this.backend.keys.submissionStatus('running'),
					this.backend.keys.submissionStatus('settled'),
					this.backend.keys.sessionUnsettled(row.sessionKey),
				],
				['running', attempt.attemptId, operation, value, extra1, extra2, id],
			);
			return integer(result) === 1;
		} finally {
			await this.repairSubmissionIndexes(id);
		}
	}

	private async repairSubmissionIndexes(id: string): Promise<void> {
		const row = await this.backend.hgetall(this.backend.keys.submission(id));
		if (!row.submissionId || !row.sessionKey || !row.status || !row.sequence) return;
		const sequence = integer(row.sequence);
		const commands = ['queued', 'running', 'terminalizing', 'settled'].map((status) => ({
			command: status === row.status ? 'ZADD' : 'ZREM',
			args:
				status === row.status
					? [this.backend.keys.submissionStatus(status), sequence, id]
					: [this.backend.keys.submissionStatus(status), id],
		}));
		if (row.status === 'settled')
			commands.push({
				command: 'ZREM',
				args: [this.backend.keys.sessionUnsettled(row.sessionKey), id],
			});
		else
			commands.push({
				command: 'ZADD',
				args: [this.backend.keys.sessionUnsettled(row.sessionKey), sequence, id],
			});
		await this.backend.pipeline(commands);
	}

	private async runSessionDeletion(
		sessionKey: string,
		deleteSessionTree: () => Promise<void>,
	): Promise<void> {
		const ownerId = randomUUID();
		let cutoff: number;
		while (true) {
			const now = Date.now();
			const result = strings(
				await this.backend.eval(
					acquireDeletionScript,
					[
						this.backend.keys.deletion(sessionKey),
						this.backend.keys.sessionUnsettled(sessionKey),
						this.backend.keys.sequence(),
						this.backend.keys.deletions(),
					],
					[ownerId, now, sessionKey, now + DELETION_LEASE_MS],
				),
			);
			if (result[0] === 'active')
				throw new TypeError(
					'Session cannot be deleted while durable agent submissions are queued or running.',
				);
			if (result[0] === 'owned') {
				cutoff = integer(result[1]);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, DELETION_POLL_MS));
			if (
				integer(await this.backend.command('EXISTS', [this.backend.keys.deletion(sessionKey)])) ===
				0
			)
				return;
		}
		const heartbeat = setInterval(() => {
			void this.backend.eval(
				renewDeletionScript,
				[this.backend.keys.deletion(sessionKey)],
				[ownerId, Date.now() + DELETION_LEASE_MS],
			);
		}, DELETION_LEASE_MS / 3);
		try {
			await deleteSessionTree();
		} catch (error) {
			clearInterval(heartbeat);
			await this.backend.eval(
				finishDeletionScript,
				[this.backend.keys.deletion(sessionKey), this.backend.keys.deletions()],
				[ownerId, sessionKey],
			);
			throw error;
		}
		clearInterval(heartbeat);
		for (const id of await this.backend.zrange(this.backend.keys.sessionSubmissions(sessionKey))) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			if (row.status !== 'settled' || integer(row.sequence) > cutoff) continue;
			const journal = await this.backend.hgetall(this.backend.keys.journal(id));
			if (journal.streamKey) await this.deleteStreamChunkSegments(journal.streamKey);
			await this.chunks.delete(submissionChunkOwner(id));
			const generationIds = strings(
				await this.backend.command('ZRANGE', [this.backend.keys.submissionGenerations(id), 0, -1]),
			);
			const deleted = integer(
				await this.backend.eval(
					deleteSubmissionScript,
					[
						this.backend.keys.submission(id),
						this.backend.keys.submissionIds(),
						this.backend.keys.submissionOrder(),
						this.backend.keys.submissionStatus('settled'),
						this.backend.keys.sessionSubmissions(sessionKey),
						this.backend.keys.sessionUnsettled(sessionKey),
						this.backend.keys.deletion(sessionKey),
						this.backend.keys.journals(),
						this.backend.keys.submissionGenerations(id),
						this.backend.keys.receipt(id),
					],
					[ownerId, cutoff, id],
				),
			);
			if (deleted === 1) {
				await this.backend.command('DEL', [
					this.backend.keys.journal(id),
					this.backend.keys.submissionReaders(id),
					...generationIds.map((value) => this.backend.keys.submissionGeneration(id, value)),
				]);
			}
		}
		await this.backend.eval(
			finishDeletionScript,
			[this.backend.keys.deletion(sessionKey), this.backend.keys.deletions()],
			[ownerId, sessionKey],
		);
	}

	private async findSessionHead(sessionKey: string): Promise<AgentSubmission | null> {
		const ids = await this.backend.zrange(this.backend.keys.sessionUnsettled(sessionKey));
		for (const id of ids) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			const status = row.status === 'running' ? 'running' : 'queued';
			const value = await this.readOperationalSubmission(id, status);
			if (value) return value;
		}
		return null;
	}

	private async readOperationalSubmission(
		id: string,
		expectedStatus: 'queued' | 'running',
	): Promise<AgentSubmission | null> {
		try {
			const submission = await this.getSubmission(id);
			if (!submission || submission.status !== expectedStatus)
				throw new TypeError('Persisted Redis submission index is inconsistent.');
			return submission;
		} catch (error) {
			const row = await this.backend.hgetall(this.backend.keys.submission(id));
			const sessionKey = row.sessionKey ?? empty;
			await this.backend.eval(
				quarantineSubmissionScript,
				[
					this.backend.keys.submission(id),
					this.backend.keys.submissionStatus('queued'),
					this.backend.keys.submissionStatus('running'),
					this.backend.keys.sessionUnsettled(sessionKey),
					this.backend.keys.sessionSubmissions(sessionKey),
					this.backend.keys.submissionStatus('settled'),
				],
				[id, row.sequence ?? 0, Date.now(), error instanceof Error ? error.message : String(error)],
			);
			return null;
		}
	}

	private async readSubmissionGeneration(
		submissionId: string,
		generation?: string,
	): Promise<{ payload: string; chunks: PersistedChunkRow[] }> {
		const parse = (record: Hash) => {
			if (!record.payload)
				throw new TypeError('Persisted Redis submission generation is malformed.');
			const chunks: PersistedChunkRow[] = [];
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
		const parsed = JSON.parse(persisted.payload);
		const input =
			kind === 'direct' ? hydratePersistedDirectSubmission(parsed, persisted.chunks) : parsed;
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
			...(row.attemptId ? { attemptId: row.attemptId } : {}),
			...(row.inputAppliedAt ? { inputAppliedAt: integer(row.inputAppliedAt) } : {}),
			...(row.recoveryRequestedAt ? { recoveryRequestedAt: integer(row.recoveryRequestedAt) } : {}),
			...(row.startedAt ? { startedAt: integer(row.startedAt) } : {}),
			...(row.error ? { error: row.error } : {}),
			attemptCount: integer(row.attemptCount),
			maxRetry: integer(row.maxRetry),
			timeoutAt: integer(row.timeoutAt),
			...(row.ownerId ? { ownerId: row.ownerId } : {}),
			leaseExpiresAt: integer(row.leaseExpiresAt),
		};
	}
}

function parseJournal(row: Hash): AgentTurnJournal {
	const malformed = 'Persisted Redis turn journal is malformed.';
	return {
		submissionId: required(row.submissionId, malformed),
		sessionKey: required(row.sessionKey, malformed),
		kind: row.kind as 'dispatch' | 'direct',
		attemptId: required(row.attemptId, malformed),
		operationId: required(row.operationId, malformed),
		turnId: required(row.turnId, malformed),
		phase: row.phase as AgentTurnJournalPhase,
		revision: integer(row.revision),
		createdAt: integer(row.createdAt),
		updatedAt: integer(row.updatedAt),
		...(row.checkpointLeafId ? { checkpointLeafId: row.checkpointLeafId } : {}),
		...(row.toolRequest ? { toolRequest: JSON.parse(row.toolRequest) } : {}),
		...(row.streamKey ? { streamKey: row.streamKey } : {}),
		...(row.streamConsumedAt ? { streamConsumedAt: integer(row.streamConsumedAt) } : {}),
		committed: row.committed === '1',
		...(row.committedLeafId ? { committedLeafId: row.committedLeafId } : {}),
	};
}

class RedisRunStore {
	constructor(private backend: Backend) {}

	async createRun(input: CreateRunInput): Promise<void> {
		const orderKey = canonicalStartedAt(input.startedAt);
		await this.backend.eval(
			createRunScript,
			[
				this.backend.keys.run(input.runId),
				this.backend.keys.runs(),
				this.backend.keys.runsStatus('active'),
				this.backend.keys.runsWorkflow(input.workflowName),
				this.backend.keys.runStatuses(),
			],
			[
				input.runId,
				input.workflowName,
				input.startedAt,
				optionalJson(input.input),
				score(input.startedAt),
				orderKey,
				optionalJson(input.traceCarrier),
			],
		);
	}

	async endRun(input: EndRunInput): Promise<void> {
		const status = input.isError ? 'errored' : 'completed';
		await this.backend.eval(
			endRunScript,
			[
				this.backend.keys.run(input.runId),
				this.backend.keys.runs(),
				this.backend.keys.runsStatus(status),
				this.backend.keys.runStatuses(),
			],
			[
				input.runId,
				status,
				input.endedAt,
				input.isError ? 1 : 0,
				input.durationMs,
				optionalJson(input.result),
				optionalJson(input.error),
				`${this.backend.keys.prefix}:runs:status:`,
			],
		);
	}

	async getRun(runId: string): Promise<RunRecord | null> {
		const row = await this.backend.hgetall(this.backend.keys.run(runId));
		return row.runId ? parseRun(row) : null;
	}

	async lookupRun(runId: string): Promise<WorkflowRunPointer | null> {
		const values = await this.backend.command('HMGET', [
			this.backend.keys.run(runId),
			'runId',
			'workflowName',
		]);
		if (!Array.isArray(values) || values[0] == null || values[1] == null) return null;
		return { runId: String(values[0]), workflowName: String(values[1]) };
	}

	async listRuns(opts: ListRunsOpts = {}): Promise<ListRunsResponse> {
		const limit = clampLimit(opts.limit, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT);
		const cursor = decodeRunCursor(opts.cursor);
		const cursorStartedAt = cursor ? canonicalStartedAt(cursor.startedAt) : undefined;
		const index = opts.status
			? this.backend.keys.runsStatus(opts.status)
			: opts.workflowName
				? this.backend.keys.runsWorkflow(opts.workflowName)
				: this.backend.keys.runs();
		const ids = await this.backend.zrange(index, 0, -1, true);
		const records: RunPointer[] = [];
		for (const id of ids) {
			const run = await this.getRun(id);
			if (
				!run ||
				(opts.status && run.status !== opts.status) ||
				(opts.workflowName && run.workflowName !== opts.workflowName)
			)
				continue;
			const startedAt = canonicalStartedAt(run.startedAt);
			if (
				cursor &&
				cursorStartedAt &&
				(startedAt > cursorStartedAt ||
					(startedAt === cursorStartedAt && run.runId >= cursor.runId))
			)
				continue;
			records.push(pointer(run));
			if (records.length > limit) break;
		}
		const hasNext = records.length > limit;
		const runs = records.slice(0, limit);
		const lastRun = runs.at(-1);
		return { runs, ...(hasNext && lastRun ? { nextCursor: encodeRunCursor(lastRun) } : {}) };
	}
}

function parseRun(row: Hash): RunRecord {
	const malformed = 'Persisted Redis run is malformed.';
	return {
		runId: required(row.runId, malformed),
		workflowName: required(row.workflowName, malformed),
		status: row.status as RunStatus,
		startedAt: required(row.startedAt, malformed),
		...(row.payload ? { input: JSON.parse(row.payload) } : {}),
		...(row.endedAt ? { endedAt: row.endedAt } : {}),
		...(row.isError ? { isError: row.isError === '1' } : {}),
		...(row.durationMs ? { durationMs: integer(row.durationMs) } : {}),
		...(row.result ? { result: JSON.parse(row.result) } : {}),
		...(row.error ? { error: JSON.parse(row.error) } : {}),
		...(row.traceCarrier ? { traceCarrier: JSON.parse(row.traceCarrier) } : {}),
	};
}

function pointer(run: RunRecord): RunPointer {
	return {
		runId: run.runId,
		workflowName: run.workflowName,
		status: run.status,
		startedAt: run.startedAt,
		...(run.endedAt ? { endedAt: run.endedAt } : {}),
		...(run.isError !== undefined ? { isError: run.isError } : {}),
		...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
	};
}

class RedisEventStreamStore implements EventStreamStore {
	private listeners = new Map<string, Set<() => void>>();
	constructor(private backend: Backend) {}

	async createStream(path: string): Promise<void> {
		await this.backend.command('HSETNX', [this.backend.keys.event(path), 'nextOffset', 0]);
		await this.backend.command('HSETNX', [this.backend.keys.event(path), 'closed', 0]);
		await this.backend.command('SADD', [this.backend.keys.events(), path]);
	}

	async appendEvent(path: string, event: unknown): Promise<string> {
		const result = strings(
			await this.backend.eval(
				appendEventScript,
				[
					this.backend.keys.event(path),
					this.backend.keys.eventEntries(path),
					this.backend.keys.eventOrder(path),
				],
				[json(event)],
			),
		);
		if (result[0] === 'missing') throw new TypeError(`Event stream "${path}" does not exist.`);
		if (result[0] === 'closed') throw new TypeError(`Event stream "${path}" is closed.`);
		this.notify(path);
		return formatOffset(integer(result[1]));
	}

	async appendEventOnce(path: string, key: string, event: unknown): Promise<string> {
		const result = strings(await this.backend.eval(appendEventOnceScript, [
			this.backend.keys.event(path), this.backend.keys.eventEntries(path),
			this.backend.keys.eventOrder(path), this.backend.keys.eventKeys(path),
		], [key, json(event)]));
		if (result[0] === 'missing') throw new TypeError(`Event stream "${path}" does not exist.`);
		if (result[0] === 'closed') throw new TypeError(`Event stream "${path}" is closed.`);
		if (result[0] === 'conflict') throw new TypeError(`Event key "${key}" has a conflicting payload.`);
		this.notify(path);
		return formatOffset(integer(result[1]));
	}

	async readEvents(
		path: string,
		opts?: { offset?: string; limit?: number },
	): Promise<EventStreamReadResult> {
		const meta = await this.getStreamMeta(path);
		if (!meta) return { events: [], nextOffset: formatOffset(-1), upToDate: true, closed: false };
		const raw = opts?.offset ?? '-1';
		if (raw === 'now')
			return { events: [], nextOffset: meta.nextOffset, upToDate: true, closed: meta.closed };
		const start = raw === '-1' ? -1 : parseOffset(raw);
		const limit = clampLimit(opts?.limit, DEFAULT_READ_LIMIT, MAX_READ_LIMIT);
		const sequences = strings(
			await this.backend.command('ZRANGEBYSCORE', [
				this.backend.keys.eventOrder(path),
				`(${start}`,
				'+inf',
				'LIMIT',
				0,
				limit + 1,
			]),
		);
		const page = sequences.slice(0, limit);
		const values =
			page.length > 0
				? strings(
						await this.backend.command('HMGET', [this.backend.keys.eventEntries(path), ...page]),
					)
				: [];
		const events = page.map((sequence, index) => ({
			data: JSON.parse(required(values[index], 'Persisted Redis event stream entry is malformed.')),
			offset: formatOffset(integer(sequence)),
		}));
		return {
			events,
			nextOffset: events.at(-1)?.offset ?? formatOffset(start),
			upToDate: sequences.length <= limit,
			closed: meta.closed,
		};
	}

	async closeStream(path: string): Promise<void> {
		await this.backend.eval(closeEventScript, [this.backend.keys.event(path)]);
		this.notify(path);
	}

	async getStreamMeta(path: string): Promise<EventStreamMeta | null> {
		const row = await this.backend.hgetall(this.backend.keys.event(path));
		if (!row.nextOffset) return null;
		return { nextOffset: formatOffset(integer(row.nextOffset) - 1), closed: row.closed === '1' };
	}

	subscribe(path: string, listener: () => void): () => void {
		const set = this.listeners.get(path) ?? new Set();
		set.add(listener);
		this.listeners.set(path, set);
		return () => {
			set.delete(listener);
			if (set.size === 0) this.listeners.delete(path);
		};
	}

	private notify(path: string): void {
		for (const listener of this.listeners.get(path) ?? []) {
			try {
				listener();
			} catch {}
		}
	}
}
