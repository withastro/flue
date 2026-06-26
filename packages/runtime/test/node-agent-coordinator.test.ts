import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
	Type,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import { SubmissionInterruptedError } from '../src/errors.ts';
import { createFlueContext, type DispatchInput, resolveModel } from '../src/internal.ts';
import {
	createNodeAgentCoordinator,
	createNodeDispatchQueue,
	type NodeAgentCoordinator,
} from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import { agentStreamPath } from '../src/runtime/event-stream-store.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { generateSessionAffinityKey } from '../src/runtime/ids.ts';
import { createSessionStorageKey } from '../src/session-identity.ts';
import { defineTool } from '../src/tool.ts';
import type { SessionData } from '../src/types.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';
import { createTestEventStreamStore } from './helpers/test-event-stream-store.ts';

// ---------------------------------------------------------------------------
// Env setup — load ANTHROPIC_API_KEY from the repo .env file.
// Used only by the 'real Anthropic API smoke' describe block at the bottom;
// everything else in this suite runs keyless against the faux provider.
// ---------------------------------------------------------------------------

try {
	const envPath = join(__dirname, '..', '..', '..', '.env');
	const envContent = readFileSync(envPath, 'utf8');
	for (const line of envContent.split('\n')) {
		const match = line.match(/^([A-Z_]+)=(.+)$/);
		if (match?.[1] && match[2]) process.env[match[1]] = match[2].trim();
	}
} catch {}

const REAL_MODEL = 'anthropic/claude-haiku-4-5';
const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const providers: FauxProviderRegistration[] = [];
const tempDirs: string[] = [];

afterEach(() => {
	for (const provider of providers.splice(0)) provider.unregister();
	for (const dir of tempDirs.splice(0)) {
		try {
			rmSync(dir, { recursive: true });
		} catch {}
	}
});

function createFauxProvider(): FauxProviderRegistration {
	const provider = registerFauxProvider({
		provider: `node-coordinator-test-${crypto.randomUUID()}`,
	});
	providers.push(provider);
	return provider;
}

function createTempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), 'flue-node-coordinator-'));
	tempDirs.push(dir);
	return join(dir, 'agent.db');
}

/** Open (or reopen) a file-backed execution store via the sqlite() adapter. */
async function openExecutionStore(dbPath: string): Promise<AgentExecutionStore> {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { executionStore } = await adapter.connect();
	return executionStore;
}

/** Create a context factory that uses a real LLM model. */
function makeRealCreateContext(executionStore: AgentExecutionStore): CreateAgentContextFn {
	const model = resolveModel(REAL_MODEL);
	return ({ id, request, initialEventIndex, dispatchId }) =>
		createFlueContext({
			id,
			dispatchId,
			env: {},
			req: request,
			initialEventIndex,
			agentConfig: {
				subagents: {},
				resolveModel: (m) => (m ? resolveModel(m) : model),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: executionStore.sessions,
			submissionStore: executionStore.submissions,
		});
}

/** Create a context factory that uses a faux (mock) provider. */
function makeFauxCreateContext(
	provider: FauxProviderRegistration,
	executionStore: AgentExecutionStore,
): CreateAgentContextFn {
	return ({ id, request, initialEventIndex, dispatchId }) =>
		createFlueContext({
			id,
			dispatchId,
			env: {},
			req: request,
			initialEventIndex,
			agentConfig: {
				subagents: {},
				resolveModel: () => provider.getModel(),
			},
			createDefaultEnv: async () => createNoopSessionEnv({ cwd: '/' }),
			defaultStore: executionStore.sessions,
			submissionStore: executionStore.submissions,
		});
}

function makeDispatchInput(overrides: Partial<DispatchInput> = {}): DispatchInput {
	return {
		dispatchId: `dispatch-${crypto.randomUUID()}`,
		agent: 'assistant',
		id: 'instance-1',
		input: { message: 'Hello' },
		acceptedAt: new Date().toISOString(),
		...overrides,
	};
}

/** Create a coordinator backed by a real LLM. */
async function createRealCoordinator(
	dbPath: string,
): Promise<{ coordinator: NodeAgentCoordinator; executionStore: AgentExecutionStore }> {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { executionStore, conversationStreamStore, conversationSnapshotStore } = await adapter.connect();
	const agent = defineAgent(() => ({ model: REAL_MODEL }));
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		sessions: executionStore.sessions,
		agents: [{ name: 'assistant', definition: agent }],
		createContext: makeRealCreateContext(executionStore),
		eventStreamStore: createTestEventStreamStore(),
		conversationStreamStore,
		conversationSnapshotStore,
	});
	return { coordinator, executionStore };
}

/** Create a coordinator backed by a faux (mock) provider. */
async function createFauxCoordinator(
	dbPath: string,
	provider: FauxProviderRegistration,
	durability?: { maxAttempts?: number; timeoutMs?: number },
): Promise<{ coordinator: NodeAgentCoordinator; executionStore: AgentExecutionStore }> {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { executionStore, conversationStreamStore, conversationSnapshotStore } = await adapter.connect();
	const agent = defineAgent(() => ({
		model: `${provider.getModel().provider}/${provider.getModel().id}`,
		durability,
	}));
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		sessions: executionStore.sessions,
		agents: [{ name: 'assistant', definition: agent }],
		createContext: makeFauxCreateContext(provider, executionStore),
		eventStreamStore: createTestEventStreamStore(),
		conversationStreamStore,
		conversationSnapshotStore,
	});
	return { coordinator, executionStore };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeAgentCoordinator', () => {
	describe('basic lifecycle', () => {
		it('writes canonical input and assistant output when processing a dispatch', async () => {
		const dbPath = createTempDbPath();
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Hello back')]);
		const { coordinator } = await createFauxCoordinator(dbPath, provider);
		const input = makeDispatchInput();

		await coordinator.admitDispatch(input);
		await coordinator.waitForIdle();

		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { conversationStreamStore } = await adapter.connect();
		const read = await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1'));
		const records = read.batches.flatMap((batch) => batch.records);
		expect(records.map((record) => record.type)).toEqual(expect.arrayContaining([
			'conversation_created',
			'signal',
			'assistant_message_started',
			'assistant_text_delta',
			'assistant_text_completed',
			'assistant_message_completed',
		]));
		const inputRecord = records.find((record) => record.type === 'signal');
		const assistantRecord = records.find((record) => record.type === 'assistant_message_started');
		expect(inputRecord).toMatchObject({ dispatchId: input.dispatchId, signalType: 'dispatch_input' });
		expect(assistantRecord).toMatchObject({ parentId: `entry_dispatch_${input.dispatchId}` });

		await coordinator.shutdown();
	});

	it('rebuilds canonical state when the disposable snapshot is deleted', async () => {
		const dbPath = createTempDbPath();
		const provider = createFauxProvider();
		provider.setResponses([fauxAssistantMessage('Snapshot reply')]);
		const { coordinator } = await createFauxCoordinator(dbPath, provider);
		const input = makeDispatchInput();
		await coordinator.admitDispatch(input);
		await coordinator.waitForIdle();
		await coordinator.shutdown();

		const adapter = sqlite(dbPath);
		await adapter.migrate?.();
		const { conversationStreamStore, conversationSnapshotStore } = await adapter.connect();
		const path = agentStreamPath('assistant', 'instance-1');
		const snapshot = await conversationSnapshotStore.load(path);
		expect(snapshot).not.toBeNull();
		await conversationSnapshotStore.delete(path);
		const read = await conversationStreamStore.read(path);
		expect(read.batches.flatMap((batch) => batch.records).map((record) => record.type)).toContain('assistant_message_completed');
	});

	it('processes a dispatch through the full submission lifecycle with file persistence', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			await coordinator.waitForIdle();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
			expect(submission?.error).toBeUndefined();
		});

		it('persists settled submission across store reopens', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			await coordinator.waitForIdle();

			// "Restart": open the same file with a fresh store.
			const reopened = await openExecutionStore(dbPath);
			const submission = await reopened.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
			expect(submission?.error).toBeUndefined();
			expect(await reopened.submissions.hasUnsettledSubmissions()).toBe(false);
		});
	});

	describe('interrupt and recover', () => {
		it('reconciles an interrupted submission by requeuing when canonical input is absent', async () => {
			const dbPath = createTempDbPath();
			// First process will be "interrupted" — we manually admit+claim without processing.
			const store1 = await openExecutionStore(dbPath);
			const input = makeDispatchInput();
			await store1.submissions.admitDispatch(input);
			await store1.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-interrupted',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			// Submission is now running with no canonical input — simulates crash before input applied.

			// "Restart": a new coordinator reconciles and replays the dispatch input.
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered reply.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});

		it('performs exactly one expired-lease pass when reconciling a startup backlog', async () => {
			const dbPath = createTempDbPath();
			// Backlog: a claimed submission whose lease expired (crashed process).
			const store1 = await openExecutionStore(dbPath);
			const input = makeDispatchInput();
			await store1.submissions.admitDispatch(input);
			await store1.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-interrupted',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});

			// "Restart": reconcileSubmissions() starts the claim loop (whose
			// first claim pass also scans for expired leases) and then runs
			// its own awaited reconciliation. The two must share one pass,
			// not race two over the same expired submissions.
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered reply.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			const listExpired = vi.spyOn(executionStore.submissions, 'listExpiredSubmissions');
			await coordinator.reconcileSubmissions();

			expect(listExpired).toHaveBeenCalledTimes(1);
			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});

		it('terminalizes an interrupted submission when input was applied but no response completed', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Complete response.')]);

			// Process fully, then simulate an interrupted second dispatch to same session.
			const { coordinator: coord1, executionStore: store1 } = await createFauxCoordinator(
				dbPath,
				provider,
			);
			const input1 = makeDispatchInput({ dispatchId: 'dispatch-first' });
			await coord1.admitDispatch(input1);
			await coord1.waitForIdle();

			// Now manually admit+claim a second dispatch without processing — leave running.
			const input2 = makeDispatchInput({ dispatchId: 'dispatch-second' });
			await store1.submissions.admitDispatch(input2);
			await store1.submissions.claimSubmission({
				submissionId: input2.dispatchId,
				attemptId: 'attempt-interrupted',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			// Mark input applied to simulate crash after input was persisted.
			await store1.submissions.markSubmissionInputApplied({
				submissionId: input2.dispatchId,
				attemptId: 'attempt-interrupted',
			});

			// "Restart": the second submission's input is applied but no completed response.
			// It should be terminalized (not replayed).
			const { coordinator: coord2, executionStore: store2 } = await createFauxCoordinator(
				dbPath,
				provider,
			);
			await coord2.reconcileSubmissions();

			const submission = await store2.submissions.getSubmission(input2.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			// This should have an error because input was applied but no completed response exists
			// for this specific submission.
			expect(submission?.error).toBeDefined();
		});

		it('retries a submission whose input was applied but whose journal was never created', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);

			// Crash window between the input-application marker and the first
			// turn-journal write: the canonical input is persisted, the marker
			// fired, but no journal row exists — the provider was provably
			// never reached, so reconciliation must retry instead of
			// terminalizing.
			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);
			await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-no-journal',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			await store.submissions.markSubmissionInputApplied({
				submissionId: input.dispatchId,
				attemptId: 'attempt-no-journal',
			});
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Hello', timestamp: Date.now() } as any,
						dispatch: { dispatchId: input.dispatchId },
					},
				],
				leafId: 'e1',
				metadata: {},
				createdAt: now,
				updatedAt: now,
			});

			// "Restart": reconciliation replays the turn from the persisted input.
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered from persisted input.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
			const session = await executionStore.sessions.load(storageKey);
			const entries = session?.entries ?? [];
			const assistants = entries.filter(
				(entry) => entry.type === 'message' && entry.message.role === 'assistant',
			);
			expect(assistants.at(-1)).toMatchObject({
				message: { content: [{ type: 'text', text: 'Recovered from persisted input.' }] },
			});
			const advisories = entries.filter(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'signal' &&
					(entry.message as any).type === 'submission_interrupted',
			);
			expect(advisories).toEqual([]);
		});

		it('resumes a submission interrupted during transient-retry backoff after restart', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);

			// Crash during the transient-retry backoff: the provider returned a
			// retryable error which was checkpointed WITHOUT committing the
			// journal, and the process died waiting to retry. Restart must
			// resume the retry rather than terminally failing the submission.
			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);
			const claimed = await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-backoff',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			expect(claimed).toBeTruthy();
			if (!claimed) throw new Error('Expected claimed submission.');
			await store.submissions.markSubmissionInputApplied({
				submissionId: input.dispatchId,
				attemptId: 'attempt-backoff',
			});
			await store.submissions.beginTurnJournal({
				submissionId: input.dispatchId,
				sessionKey: claimed.sessionKey,
				kind: 'dispatch',
				attemptId: 'attempt-backoff',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});
			await store.submissions.updateTurnJournalPhase(
				{ submissionId: input.dispatchId, attemptId: 'attempt-backoff' },
				'provider_started',
			);
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Hello', timestamp: Date.now() } as any,
						dispatch: { dispatchId: input.dispatchId },
					},
					{
						type: 'message',
						id: 'e2',
						parentId: 'e1',
						timestamp: now,
						message: {
							role: 'assistant',
							content: [],
							stopReason: 'error',
							errorMessage: '429 Too Many Requests',
							api: 'test',
							provider: 'test',
							model: 'test',
							usage: {
								input: 0,
								output: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, total: 0 },
							},
							timestamp: Date.now(),
						} as any,
					},
				],
				leafId: 'e2',
				metadata: {},
				createdAt: now,
				updatedAt: now,
			});

			// "Restart": reconciliation resumes the retry (waiting out the
			// backoff) and completes the submission.
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered after backoff.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
			const session = await executionStore.sessions.load(storageKey);
			const entries = session?.entries ?? [];
			const assistants = entries.filter(
				(entry) => entry.type === 'message' && entry.message.role === 'assistant',
			);
			expect(assistants.at(-1)).toMatchObject({
				message: { content: [{ type: 'text', text: 'Recovered after backoff.' }] },
			});
			const advisories = entries.filter(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'signal' &&
					(entry.message as any).type === 'submission_interrupted',
			);
			expect(advisories).toEqual([]);
		}, 15_000);
	});

	describe('graceful shutdown and resume', () => {
		it('resumes from recovered stream chunks after shutdown aborts a streaming turn', async () => {
			const dbPath = createTempDbPath();
			// Slow streaming so shutdown deterministically lands mid-turn with
			// partial output already persisted to durable chunk segments.
			const provider = registerFauxProvider({
				provider: `node-coordinator-test-${crypto.randomUUID()}`,
				tokensPerSecond: 50,
			});
			providers.push(provider);
			provider.setResponses([
				fauxAssistantMessage(
					`The full answer that never finishes. ${'lorem ipsum dolor '.repeat(250)}`,
				),
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			// Wait until the streaming turn has flushed at least one durable
			// chunk segment, then shut down mid-stream.
			let streamKey: string | undefined;
			await vi.waitFor(
				async () => {
					const journal = await executionStore.submissions.getTurnJournal(input.dispatchId);
					streamKey = journal?.streamKey;
					if (!streamKey) throw new Error('Stream has not started yet.');
					const segments = await executionStore.submissions.getStreamChunkSegments(streamKey);
					expect(segments.length).toBeGreaterThan(0);
				},
				{ timeout: 10_000, interval: 50 },
			);
			await coordinator.shutdown();

			// Shutdown leaves recoverable state behind: the submission stays
			// running, the journal stays uncommitted, and the partial-stream
			// chunks survive the aborted turn's checkpoint.
			expect(await executionStore.submissions.getSubmission(input.dispatchId)).toMatchObject({
				status: 'running',
			});
			const journal = await executionStore.submissions.getTurnJournal(input.dispatchId);
			expect(journal?.committed).toBe(false);
			if (!journal?.streamKey) throw new Error('Expected a stream key in the journal.');
			const segments = await executionStore.submissions.getStreamChunkSegments(journal.streamKey);
			expect(segments.length).toBeGreaterThan(0);

			// "Restart": advance the clock past the shut-down coordinator's
			// lease so reconciliation picks the submission up.
			const realNow = Date.now.bind(Date);
			const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
			try {
				provider.setResponses([fauxAssistantMessage('Recovered completion.')]);
				const { coordinator: restarted, executionStore: store2 } = await createFauxCoordinator(
					dbPath,
					provider,
				);
				await restarted.reconcileSubmissions();

				const submission = await store2.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled' });
				expect(submission?.error).toBeUndefined();
				const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
				const session = await store2.sessions.load(storageKey);
				const entries = session?.entries ?? [];
				// The aborted turn's checkpoint preserves the output collected
				// before the abort, the continuation signal marks the resume,
				// and recovery appends no second copy of the partial: durable
				// history holds exactly one aborted partial assistant.
				const abortedPartials = entries.filter(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'assistant' &&
						(entry.message as any).stopReason === 'aborted',
				);
				expect(abortedPartials).toHaveLength(1);
				expect(JSON.stringify((abortedPartials[0] as any).message.content)).toContain(
					'lorem ipsum',
				);
				const continued = entries.filter(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'signal' &&
						(entry.message as any).type === 'stream_continued',
				);
				expect(continued).toHaveLength(1);
				const assistants = entries.filter(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant',
				);
				expect(assistants.at(-1)).toMatchObject({
					message: { content: [{ type: 'text', text: 'Recovered completion.' }] },
				});
				const advisories = entries.filter(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'signal' &&
						(entry.message as any).type === 'submission_interrupted',
				);
				expect(advisories).toEqual([]);
			} finally {
				nowSpy.mockRestore();
			}
		}, 30_000);

		it('recovers a submission interrupted by shutdown during a task tool call', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			// Gate the child task session's model turn so shutdown
			// deterministically arrives while the subagent is mid-prompt.
			let releaseChild!: () => void;
			const childBlocked = new Promise<void>((resolve) => {
				releaseChild = resolve;
			});
			let childReachedResolve!: () => void;
			const childReached = new Promise<void>((resolve) => {
				childReachedResolve = resolve;
			});
			provider.setResponses([
				fauxAssistantMessage([fauxToolCall('task', { prompt: 'Delegated work' })], {
					stopReason: 'toolUse',
				}),
				async () => {
					childReachedResolve();
					await childBlocked;
					return fauxAssistantMessage('Child reply that never completes.');
				},
				// Consumed by the parent's post-tool turn, which aborts before
				// any content is delivered.
				fauxAssistantMessage('Aborted before delivery.'),
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			await childReached;
			const shutdownPromise = coordinator.shutdown();
			releaseChild();
			await shutdownPromise;

			expect(await executionStore.submissions.getSubmission(input.dispatchId)).toMatchObject({
				status: 'running',
			});
			const journal = await executionStore.submissions.getTurnJournal(input.dispatchId);
			expect(journal?.committed).toBe(false);

			// "Restart": advance the clock past the shut-down coordinator's lease.
			const realNow = Date.now.bind(Date);
			const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
			try {
				provider.setResponses([fauxAssistantMessage('Recovered after task interruption.')]);
				const { coordinator: restarted, executionStore: store2 } = await createFauxCoordinator(
					dbPath,
					provider,
				);
				await restarted.reconcileSubmissions();

				const submission = await store2.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled' });
				expect(submission?.error).toBeUndefined();
				const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
				const session = await store2.sessions.load(storageKey);
				const entries = session?.entries ?? [];
				// The interrupted task's tool result is preserved exactly as
				// collected — an error result, never a fabricated success.
				const toolResults = entries.filter(
					(entry) => entry.type === 'message' && entry.message.role === 'toolResult',
				);
				expect(toolResults).toHaveLength(1);
				expect((toolResults[0] as any).message.isError).toBe(true);
				const assistants = entries.filter(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant',
				);
				expect(assistants.at(-1)).toMatchObject({
					message: { content: [{ type: 'text', text: 'Recovered after task interruption.' }] },
				});
				// The child task session is its own session: its record survives
				// and its history keeps the aborted partial untouched.
				expect(session?.childSessions).toHaveLength(1);
				const childSessionName = session?.childSessions[0]?.session;
				if (!childSessionName) throw new Error('Expected a recorded task session.');
				const childData = await store2.sessions.load(
					createSessionStorageKey('instance-1', 'default', childSessionName),
				);
				const childAssistants = (childData?.entries ?? []).filter(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant',
				);
				expect((childAssistants.at(-1) as any)?.message.stopReason).toBe('aborted');
			} finally {
				nowSpy.mockRestore();
			}
		}, 30_000);

		it('does not re-execute completed tool calls when shutdown aborts a turn mid-batch', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const alphaCallId = `tool:alpha-${crypto.randomUUID()}`;
			const bravoCallId = `tool:bravo-${crypto.randomUUID()}`;
			const charlieCallId = `tool:charlie-${crypto.randomUUID()}`;
			provider.setResponses([
				fauxAssistantMessage(
					[
						fauxToolCall('alpha', {}, { id: alphaCallId }),
						fauxToolCall('bravo', {}, { id: bravoCallId }),
						fauxToolCall('charlie', {}, { id: charlieCallId }),
					],
					{ stopReason: 'toolUse' },
				),
				// Consumed by the post-batch turn, which aborts before delivery.
				fauxAssistantMessage('Aborted before delivery.'),
			]);

			// Adapter tools run sequentially, so the shutdown abort breaks the
			// tool loop mid-batch: alpha completes with a real (externally
			// effectful) result, bravo is interrupted in flight, charlie never
			// starts — a PARTIAL tool-result batch in durable history.
			let bravoReachedResolve!: () => void;
			const bravoReached = new Promise<void>((resolve) => {
				bravoReachedResolve = resolve;
			});
			type ToolExecute = (
				id: string,
				args: unknown,
				signal?: AbortSignal,
			) => Promise<{ content: Array<{ type: 'text'; text: string }>; details: object }>;
			const makeAgentWithSequentialTools = (
				counts: Record<string, number>,
				bravoExecute: ToolExecute,
			) =>
				defineAgent(() => ({
					model: `${provider.getModel().provider}/${provider.getModel().id}`,
					sandbox: {
						createSessionEnv: async () => createNoopSessionEnv({ cwd: '/' }),
						tools: () => [
							{
								name: 'alpha',
								label: 'alpha',
								description: 'Completes before the abort.',
								parameters: Type.Object({}),
								executionMode: 'sequential' as const,
								execute: async () => {
									counts.alpha = (counts.alpha ?? 0) + 1;
									return {
										content: [{ type: 'text' as const, text: 'alpha result' }],
										details: {},
									};
								},
							},
							{
								name: 'bravo',
								label: 'bravo',
								description: 'In flight when the abort lands.',
								parameters: Type.Object({}),
								executionMode: 'sequential' as const,
								execute: (async (id, args, signal) => {
									counts.bravo = (counts.bravo ?? 0) + 1;
									return bravoExecute(id, args, signal);
								}) satisfies ToolExecute,
							},
							{
								name: 'charlie',
								label: 'charlie',
								description: 'Never starts before the abort.',
								parameters: Type.Object({}),
								executionMode: 'sequential' as const,
								execute: async () => {
									counts.charlie = (counts.charlie ?? 0) + 1;
									return {
										content: [{ type: 'text' as const, text: 'charlie result' }],
										details: {},
									};
								},
							},
						],
					},
				}));

			const firstRunCounts: Record<string, number> = {};
			const executionStore = await openExecutionStore(dbPath);
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: makeAgentWithSequentialTools(firstRunCounts, async (_id, _args, signal) => {
							bravoReachedResolve();
							await new Promise<never>((_, reject) => {
								if (signal?.aborted) reject(new Error('bravo aborted by shutdown'));
								signal?.addEventListener(
									'abort',
									() => reject(new Error('bravo aborted by shutdown')),
									{ once: true },
								);
							});
							throw new Error('unreachable');
						}),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore: createTestEventStreamStore(),
			});

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			await bravoReached;
			await coordinator.shutdown();

			// Shutdown left the partial-batch shape behind: the submission is
			// reclaimable, the journal is uncommitted, alpha's completed result
			// and bravo's interruption error are recorded, charlie has no result.
			expect(firstRunCounts).toEqual({ alpha: 1, bravo: 1 });
			expect(await executionStore.submissions.getSubmission(input.dispatchId)).toMatchObject({
				status: 'running',
			});
			const journal = await executionStore.submissions.getTurnJournal(input.dispatchId);
			expect(journal?.committed).toBe(false);
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const interrupted = await executionStore.sessions.load(storageKey);
			const interruptedResults = (interrupted?.entries ?? []).filter(
				(entry) => entry.type === 'message' && entry.message.role === 'toolResult',
			);
			expect(interruptedResults.map((entry) => (entry as any).message.toolCallId)).toEqual([
				alphaCallId,
				bravoCallId,
			]);

			// "Restart": advance the clock past the shut-down coordinator's lease.
			const realNow = Date.now.bind(Date);
			const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
			try {
				// The restarted "model" behaves like a real one: shown a context
				// that still holds the turn's tool results it completes, but shown
				// a replayed context with the batch dropped it re-issues the tool
				// calls — which is exactly the duplicate external effect the
				// repair must prevent.
				provider.setResponses([
					(context) =>
						context.messages.some((message) => message.role === 'toolResult')
							? fauxAssistantMessage('Completed after batch repair.')
							: fauxAssistantMessage(
									[
										fauxToolCall('alpha', {}, { id: `${alphaCallId}-replayed` }),
										fauxToolCall('bravo', {}, { id: `${bravoCallId}-replayed` }),
										fauxToolCall('charlie', {}, { id: `${charlieCallId}-replayed` }),
									],
									{ stopReason: 'toolUse' },
								),
					fauxAssistantMessage('Completed after replayed tools.'),
				]);
				const restartCounts: Record<string, number> = {};
				const store2 = await openExecutionStore(dbPath);
				const restarted = createNodeAgentCoordinator({
					submissions: store2.submissions,
					sessions: store2.sessions,
					agents: [
						{
							name: 'assistant',
							definition: makeAgentWithSequentialTools(restartCounts, async () => ({
								content: [{ type: 'text' as const, text: 'bravo result (rerun)' }],
								details: {},
							})),
						},
					],
					createContext: makeFauxCreateContext(provider, store2),
					eventStreamStore: createTestEventStreamStore(),
				});
				await restarted.reconcileSubmissions();

				// No tool ran again: alpha's completed call is never re-executed,
				// and the unresolved calls are repaired, not retried.
				expect(restartCounts).toEqual({});

				const submission = await store2.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled' });
				expect(submission?.error).toBeUndefined();

				// The active path holds the repaired batch in original call order:
				// alpha's real result preserved, bravo's collected interruption
				// error preserved as recorded, charlie marked interrupted with an
				// unknown outcome — never a fabricated result.
				const session = await store2.sessions.load(storageKey);
				if (!session) throw new Error('Expected the session to persist.');
				const activePath: typeof session.entries = [];
				for (
					let entry = session.entries.find((candidate) => candidate.id === session.leafId);
					entry;
					entry = session.entries.find((candidate) => candidate.id === entry?.parentId)
				) {
					activePath.unshift(entry);
				}
				const activeResults = activePath.filter(
					(entry) => entry.type === 'message' && entry.message.role === 'toolResult',
				) as any[];
				expect(activeResults.map((entry) => entry.message.toolCallId)).toEqual([
					alphaCallId,
					bravoCallId,
					charlieCallId,
				]);
				expect(activeResults[0].message.isError).toBe(false);
				expect(activeResults[0].message.content[0]).toMatchObject({ text: 'alpha result' });
				expect(activeResults[1].message.isError).toBe(true);
				expect(activeResults[1].message.content[0].text).toContain('bravo aborted by shutdown');
				expect(activeResults[2].message.isError).toBe(true);
				expect(JSON.parse(activeResults[2].message.content[0].text)).toMatchObject({
					type: 'interrupted',
				});
				const activeAssistants = activePath.filter(
					(entry) => entry.type === 'message' && entry.message.role === 'assistant',
				) as any[];
				expect(activeAssistants.at(-1)?.message.content).toEqual([
					{ type: 'text', text: 'Completed after batch repair.' },
				]);
				const advisories = session.entries.filter(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'signal' &&
						(entry.message as any).type === 'submission_interrupted',
				);
				expect(advisories).toEqual([]);
			} finally {
				nowSpy.mockRestore();
			}
		}, 30_000);

		it('deletes the interrupted turn chunk segments when reconciliation terminalizes the submission', async () => {
			const dbPath = createTempDbPath();
			// Slow streaming so shutdown deterministically lands mid-turn with
			// partial output already persisted to durable chunk segments.
			const provider = registerFauxProvider({
				provider: `node-coordinator-test-${crypto.randomUUID()}`,
				tokensPerSecond: 50,
			});
			providers.push(provider);
			provider.setResponses([
				fauxAssistantMessage(
					`The full answer that never finishes. ${'lorem ipsum dolor '.repeat(250)}`,
				),
			]);
			// A timeout shorter than the restart's clock advance, so the
			// reconciliation terminalizes instead of resuming.
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider, {
				timeoutMs: 30_000,
			});

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			let streamKey: string | undefined;
			await vi.waitFor(
				async () => {
					const journal = await executionStore.submissions.getTurnJournal(input.dispatchId);
					streamKey = journal?.streamKey;
					if (!streamKey) throw new Error('Stream has not started yet.');
					const segments = await executionStore.submissions.getStreamChunkSegments(streamKey);
					expect(segments.length).toBeGreaterThan(0);
				},
				{ timeout: 10_000, interval: 50 },
			);
			await coordinator.shutdown();
			if (!streamKey) throw new Error('Expected a stream key.');
			expect(
				(await executionStore.submissions.getStreamChunkSegments(streamKey)).length,
			).toBeGreaterThan(0);

			// "Restart": advance the clock past both the lease and the timeout.
			const realNow = Date.now.bind(Date);
			const nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + 60_000);
			try {
				const { coordinator: restarted, executionStore: store2 } = await createFauxCoordinator(
					dbPath,
					provider,
					{ timeoutMs: 30_000 },
				);
				await restarted.reconcileSubmissions();

				const submission = await store2.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled' });
				expect(submission?.error).toContain('exceeded the configured timeout');
				// Terminal settlement leaves no orphaned chunk segments behind:
				// nothing will ever recover or supersede them after this point.
				expect(await store2.submissions.getStreamChunkSegments(streamKey)).toEqual([]);
			} finally {
				nowSpy.mockRestore();
			}
		}, 30_000);
	});

	describe('attempt exhaustion', () => {
		it('terminalizes a submission after exceeding the retry budget', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = await openExecutionStore(dbPath);

			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);

			// Simulate repeated interruptions until retry budget is exhausted.
			// Default maxRetry is 10. We claim, then replace the attempt to increment count.
			const claimed = await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-0',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			expect(claimed).toBeTruthy();
			if (!claimed) throw new Error('Expected claimed submission.');

			// Mark input applied: journal-attempt replacement only happens after
			// input application, and pre-input exhaustion settles with its own
			// interrupted-before-input error instead of this message.
			await store.submissions.markSubmissionInputApplied({
				submissionId: input.dispatchId,
				attemptId: 'attempt-0',
			});

			// Create a journal so replaceTurnJournalAttempt can work.
			await store.submissions.beginTurnJournal({
				submissionId: input.dispatchId,
				sessionKey: claimed.sessionKey,
				kind: 'dispatch',
				attemptId: 'attempt-0',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});

			// Increment attempt count by repeatedly replacing the journal attempt.
			let currentAttemptId = 'attempt-0';
			for (let i = 1; i <= 10; i++) {
				const nextAttemptId = `attempt-${i}`;
				const replacement = await store.submissions.replaceTurnJournalAttempt(
					{ submissionId: input.dispatchId, attemptId: currentAttemptId },
					nextAttemptId,
				);
				if (!replacement) break;
				currentAttemptId = nextAttemptId;
				// Re-create the journal for the new attempt so the next replace works.
				if (i < 10) {
					await store.submissions.beginTurnJournal({
						submissionId: input.dispatchId,
						sessionKey: claimed.sessionKey,
						kind: 'dispatch',
						attemptId: currentAttemptId,
						operationId: 'op-1',
						turnId: `turn-${i + 1}`,
						phase: 'before_provider',
					});
				}
			}

			// Now attemptCount should be >= maxRetry.
			const exhausted = await store.submissions.getSubmission(input.dispatchId);
			expect(exhausted?.attemptCount).toBeGreaterThanOrEqual(exhausted?.maxRetry ?? 0);

			// "Restart": reconciliation should terminalize.
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toContain('exceeded maximum recovery attempts');
		});

		it('terminalizes with an interrupted-before-input error when repeated pre-input requeue cycles exhaust the budget', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = await openExecutionStore(dbPath);

			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);

			// Simulate repeated pre-input interruption cycles: each restart
			// claims the submission (incrementing attemptCount), is interrupted
			// before input application, and reconciliation requeues it. Default
			// maxAttempts is 10 — nine full cycles plus a final interrupted
			// claim exhaust the budget without input ever being applied.
			for (let i = 0; i < 9; i++) {
				const attemptId = `attempt-preinput-${i}`;
				const claimed = await store.submissions.claimSubmission({
					submissionId: input.dispatchId,
					attemptId,
					ownerId: 'test-owner',
					leaseExpiresAt: 1,
				});
				expect(claimed).toBeTruthy();
				const requeued = await store.submissions.requeueSubmissionBeforeInputApplied({
					submissionId: input.dispatchId,
					attemptId,
				});
				expect(requeued).toBe(true);
			}
			const finalClaim = await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-preinput-final',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			expect(finalClaim?.attemptCount).toBeGreaterThanOrEqual(finalClaim?.maxRetry ?? 0);

			// "Restart": reconciliation terminalizes — and the terminal error
			// must say the submission was interrupted before input application,
			// not that recovery attempts were exhausted (no provider work ever
			// started, so there was nothing to recover).
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toContain('interrupted before input application');
			expect(submission?.error).not.toContain('exceeded maximum recovery attempts');
		});

		it('settles a completed canonical response as success when the retry budget is exhausted', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = await openExecutionStore(dbPath);

			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);
			// Claiming increments attemptCount to 1; persisting maxRetry of 1
			// exhausts the budget while the canonical response is completed.
			await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-exhausted-completed',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			await store.submissions.markSubmissionInputApplied(
				{ submissionId: input.dispatchId, attemptId: 'attempt-exhausted-completed' },
				{ maxRetry: 1, timeoutAt: 0 },
			);

			// Persist a session where the dispatched input already has a
			// completed canonical response — the crash happened after the
			// response was checkpointed but before the submission settled.
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Hello', timestamp: Date.now() } as any,
						dispatch: { dispatchId: input.dispatchId },
					},
					{
						type: 'message',
						id: 'e2',
						parentId: 'e1',
						timestamp: now,
						message: {
							role: 'assistant',
							content: [{ type: 'text', text: 'Completed canonical response.' }],
							stopReason: 'stop',
							api: 'test',
							provider: 'test',
							model: 'test',
							usage: {
								input: 0,
								output: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, total: 0 },
							},
							timestamp: Date.now(),
						} as any,
					},
				],
				leafId: 'e2',
				metadata: {},
				createdAt: now,
				updatedAt: now,
			});

			// "Restart": reconciliation must preserve the completed work —
			// settle success, no terminalization, no interruption advisory.
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
			const session = await executionStore.sessions.load(storageKey);
			const advisories = (session?.entries ?? []).filter(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'signal' &&
					(entry.message as any).type === 'submission_interrupted',
			);
			expect(advisories).toEqual([]);
		});
	});

	describe('timeout', () => {
		it('persists configured durability when input is applied', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider, {
				maxAttempts: 3,
				timeoutMs: 7_200_000,
			});

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			await coordinator.waitForIdle();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission?.maxRetry).toBe(3);
			expect(submission?.timeoutAt).toBeGreaterThanOrEqual(
				(submission?.startedAt ?? 0) + 7_200_000,
			);
		});

		it('terminalizes a submission after the configured timeout expires', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = await openExecutionStore(dbPath);

			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);

			// Claim with a timeout that's already expired.
			const pastTimeout = Date.now() - 1000;
			await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-timeout',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			await store.submissions.markSubmissionInputApplied(
				{ submissionId: input.dispatchId, attemptId: 'attempt-timeout' },
				{ maxRetry: 10, timeoutAt: pastTimeout },
			);

			// "Restart": reconciliation should terminalize due to timeout.
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toContain('exceeded the configured timeout');
		});

		it('settles a completed canonical response as success when the configured timeout has expired', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = await openExecutionStore(dbPath);

			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);
			await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-timeout-completed',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			await store.submissions.markSubmissionInputApplied(
				{ submissionId: input.dispatchId, attemptId: 'attempt-timeout-completed' },
				{ maxRetry: 10, timeoutAt: Date.now() - 1000 },
			);

			// Persist a session where the dispatched input already has a
			// completed canonical response — the crash happened after the
			// response was checkpointed but before the submission settled.
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Hello', timestamp: Date.now() } as any,
						dispatch: { dispatchId: input.dispatchId },
					},
					{
						type: 'message',
						id: 'e2',
						parentId: 'e1',
						timestamp: now,
						message: {
							role: 'assistant',
							content: [{ type: 'text', text: 'Completed canonical response.' }],
							stopReason: 'stop',
							api: 'test',
							provider: 'test',
							model: 'test',
							usage: {
								input: 0,
								output: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, total: 0 },
							},
							timestamp: Date.now(),
						} as any,
					},
				],
				leafId: 'e2',
				metadata: {},
				createdAt: now,
				updatedAt: now,
			});

			// "Restart": reconciliation must preserve the completed work —
			// settle success, no terminalization, no interruption advisory.
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
			const session = await executionStore.sessions.load(storageKey);
			const advisories = (session?.entries ?? []).filter(
				(entry) =>
					entry.type === 'message' &&
					entry.message.role === 'signal' &&
					(entry.message as any).type === 'submission_interrupted',
			);
			expect(advisories).toEqual([]);
		});
	});

	describe('tool repair across restart', () => {
		it('continues from canonical tool results when the journal is still tool_request_recorded after restart', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Completed after preserved tool result.')]);
			const store = await openExecutionStore(dbPath);
			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);
			const claimed = await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-tool-result',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			expect(claimed).toBeTruthy();
			if (!claimed) throw new Error('Expected claimed submission.');
			await store.submissions.markSubmissionInputApplied({
				submissionId: input.dispatchId,
				attemptId: 'attempt-tool-result',
			});
			await store.submissions.beginTurnJournal({
				submissionId: input.dispatchId,
				sessionKey: claimed.sessionKey,
				kind: 'dispatch',
				attemptId: 'attempt-tool-result',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});
			await store.submissions.updateTurnJournalPhase(
				{ submissionId: input.dispatchId, attemptId: 'attempt-tool-result' },
				'tool_request_recorded',
				{
					toolRequest: {
						toolCalls: [{ type: 'toolCall', id: 'tc-1', name: 'lookup' }],
					},
				},
			);
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Run the tool.', timestamp: Date.now() } as any,
						dispatch: { dispatchId: input.dispatchId },
					},
					{
						type: 'message',
						id: 'e2',
						parentId: 'e1',
						timestamp: now,
						message: {
							role: 'assistant',
							content: [{ type: 'toolCall', id: 'tc-1', name: 'lookup', arguments: {} }],
							stopReason: 'toolUse',
							api: 'test',
							provider: 'test',
							model: 'test',
							usage: {
								input: 0,
								output: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, total: 0 },
							},
							timestamp: Date.now(),
						} as any,
					},
					{
						type: 'message',
						id: 'e3',
						parentId: 'e2',
						timestamp: now,
						message: {
							role: 'toolResult',
							toolCallId: 'tc-1',
							toolName: 'lookup',
							content: [{ type: 'text', text: 'found it' }],
							isError: false,
							timestamp: Date.now(),
						} as any,
					},
				],
				leafId: 'e3',
				metadata: {},
				createdAt: now,
				updatedAt: now,
			});

			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});

		it('repairs interrupted tool calls and completes the submission after restart', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();

			// Set up: two tool calls, process will be interrupted mid-execution.
			const toolCalls = [
				{ id: 'tc-1', name: 'get_weather' },
				{ id: 'tc-2', name: 'get_time' },
			];

			// Manually build the interrupted session state in the store.
			const store = await openExecutionStore(dbPath);
			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);
			const claimed = await store.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-tool-repair',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			expect(claimed).toBeTruthy();
			if (!claimed) throw new Error('Expected claimed submission.');

			// Mark input applied (the submission got past input application).
			await store.submissions.markSubmissionInputApplied({
				submissionId: input.dispatchId,
				attemptId: 'attempt-tool-repair',
			});

			// Create a journal at tool_request_recorded phase (interrupted during tool execution).
			await store.submissions.beginTurnJournal({
				submissionId: input.dispatchId,
				sessionKey: claimed.sessionKey,
				kind: 'dispatch',
				attemptId: 'attempt-tool-repair',
				operationId: 'op-1',
				turnId: 'turn-1',
				phase: 'before_provider',
			});
			await store.submissions.updateTurnJournalPhase(
				{ submissionId: input.dispatchId, attemptId: 'attempt-tool-repair' },
				'tool_request_recorded',
				{
					toolRequest: { toolCalls: toolCalls.map((tc) => ({ type: 'toolCall' as const, ...tc })) },
				},
			);

			// Also persist the session history up to the tool calls (user msg + assistant msg).
			const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Run the tools.', timestamp: Date.now() } as any,
						dispatch: { dispatchId: input.dispatchId },
					},
					{
						type: 'message',
						id: 'e2',
						parentId: 'e1',
						timestamp: now,
						message: {
							role: 'assistant',
							content: toolCalls.map((tc) => ({
								type: 'toolCall',
								id: tc.id,
								name: tc.name,
								arguments: {},
							})),
							stopReason: 'toolUse',
							api: 'test',
							provider: 'test',
							model: 'test',
							usage: {
								input: 0,
								output: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, total: 0 },
							},
							timestamp: Date.now(),
						} as any,
					},
				],
				leafId: 'e2',
				metadata: {},
				createdAt: now,
				updatedAt: now,
			});

			// "Restart": The new coordinator should repair the interrupted tools and re-process.
			// After repair, the provider will be called again with the repaired context.
			provider.setResponses([fauxAssistantMessage('Completed after tool repair.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});
	});

	describe('turn journal during tool-use turns', () => {
		it('persists assistant tool request before recording tool_request_recorded when a turn invokes a tool', async () => {
			const executionStore = await openExecutionStore(createTempDbPath());
			const provider = createFauxProvider();
			const toolCallId = `tool:journal-order-${crypto.randomUUID()}`;
			provider.setResponses([
				fauxAssistantMessage(fauxToolCall('lookup', { q: 'x' }, { id: toolCallId }), {
					stopReason: 'toolUse',
				}),
				fauxAssistantMessage('Done.'),
			]);
			const lookup = defineTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({ q: v.string() }),
				run: async () => 'found it',
			});
			const events: Array<{ type: 'save'; data: SessionData } | { type: 'phase'; phase: string }> =
				[];
			const originalSave = executionStore.sessions.save.bind(executionStore.sessions);
			executionStore.sessions.save = async (id, data) => {
				events.push({ type: 'save', data });
				return originalSave(id, data);
			};
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
							tools: [lookup],
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore: createTestEventStreamStore(),
			});
			const originalUpdate = executionStore.submissions.updateTurnJournalPhase.bind(
				executionStore.submissions,
			);
			executionStore.submissions.updateTurnJournalPhase = async (attempt, phase, options) => {
				events.push({ type: 'phase', phase });
				return originalUpdate(attempt, phase, options);
			};

			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch:journal-order' }));
			await coordinator.waitForIdle();

			const toolRequestIndex = events.findIndex(
				(event) => event.type === 'phase' && event.phase === 'tool_request_recorded',
			);
			expect(toolRequestIndex).toBeGreaterThan(0);
			const precedingSave = events
				.slice(0, toolRequestIndex)
				.reverse()
				.find((event): event is { type: 'save'; data: SessionData } => event.type === 'save');
			expect(
				precedingSave?.data.entries.some(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'assistant' &&
						entry.message.content.some(
							(content) => content.type === 'toolCall' && content.id === toolCallId,
						),
				),
			).toBe(true);
		});

		it('records journal phase transitions through tool_request_recorded during a tool-use turn', async () => {
			const executionStore = await openExecutionStore(createTempDbPath());
			const provider = createFauxProvider();
			const toolCallId = `tool:journal-${crypto.randomUUID()}`;
			provider.setResponses([
				fauxAssistantMessage(fauxToolCall('lookup', { q: 'x' }, { id: toolCallId }), {
					stopReason: 'toolUse',
				}),
				fauxAssistantMessage('Done.'),
			]);
			const lookup = defineTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({ q: v.string() }),
				run: async () => 'found it',
			});
			const phases: string[] = [];
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
							tools: [lookup],
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore: createTestEventStreamStore(),
			});

			const originalUpdate = executionStore.submissions.updateTurnJournalPhase.bind(
				executionStore.submissions,
			);
			executionStore.submissions.updateTurnJournalPhase = async (attempt, phase, options) => {
				phases.push(phase);
				return originalUpdate(attempt, phase, options);
			};

			const input = makeDispatchInput({ dispatchId: 'dispatch:journal-phases' });
			await coordinator.admitDispatch(input);
			await coordinator.waitForIdle();

			expect(phases).toContain('provider_started');
			expect(phases).toContain('tool_request_recorded');
			expect(phases.filter((p) => p === 'before_provider').length).toBeGreaterThanOrEqual(1);
			const journal = await executionStore.submissions.getTurnJournal(input.dispatchId);
			expect(journal?.committed).toBe(true);
		});
	});

	describe('queue ordering across restart', () => {
		it('reconciles the interrupted submission before processing queued work in the same session', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);

			// Admit two dispatches to the same session.
			const inputA = makeDispatchInput({ dispatchId: 'dispatch-A' });
			const inputB = makeDispatchInput({ dispatchId: 'dispatch-B' });
			await store.submissions.admitDispatch(inputA);
			await store.submissions.admitDispatch(inputB);

			// Claim A (the session head), leave B queued.
			await store.submissions.claimSubmission({
				submissionId: inputA.dispatchId,
				attemptId: 'attempt-A',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			// A is now running but unprocessed (simulates crash).

			// "Restart": reconcile should handle A (requeue since no input applied),
			// then process A, then drain B.
			const provider = createFauxProvider();
			provider.setResponses([
				fauxAssistantMessage('Reply for A.'),
				fauxAssistantMessage('Reply for B.'),
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			const subA = await executionStore.submissions.getSubmission(inputA.dispatchId);
			const subB = await executionStore.submissions.getSubmission(inputB.dispatchId);
			expect(subA).toMatchObject({ status: 'settled' });
			expect(subA?.error).toBeUndefined();
			expect(subB).toMatchObject({ status: 'settled' });
			expect(subB?.error).toBeUndefined();
			expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
		});

		it('processes multiple queued submissions to the same instance', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([
				fauxAssistantMessage('Reply for A.'),
				fauxAssistantMessage('Reply for B.'),
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const inputA = makeDispatchInput({ dispatchId: 'dispatch-sessA' });
			const inputB = makeDispatchInput({ dispatchId: 'dispatch-sessB' });

			await coordinator.admitDispatch(inputA);
			await coordinator.admitDispatch(inputB);
			await coordinator.waitForIdle();

			const subA = await executionStore.submissions.getSubmission(inputA.dispatchId);
			const subB = await executionStore.submissions.getSubmission(inputB.dispatchId);
			expect(subA).toMatchObject({ status: 'settled' });
			expect(subA?.error).toBeUndefined();
			expect(subB).toMatchObject({ status: 'settled' });
			expect(subB?.error).toBeUndefined();
		});
	});

	describe('queue drain after dispatch', () => {
		it('drains queued submissions after processing a new dispatch', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);

			// Pre-queue a submission from a "previous process" that was never claimed.
			const inputOld = makeDispatchInput({ dispatchId: 'dispatch-old' });
			await store.submissions.admitDispatch(inputOld);

			// Now create a fresh coordinator and dispatch a new submission.
			const provider = createFauxProvider();
			provider.setResponses([
				fauxAssistantMessage('Reply for new.'),
				fauxAssistantMessage('Reply for old.'),
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const inputNew = makeDispatchInput({ dispatchId: 'dispatch-new' });
			await coordinator.admitDispatch(inputNew);
			await coordinator.waitForIdle();

			// Both should be settled: the new one from direct processing, the old one from drain.
			const subOld = await executionStore.submissions.getSubmission(inputOld.dispatchId);
			const subNew = await executionStore.submissions.getSubmission(inputNew.dispatchId);
			expect(subNew).toMatchObject({ status: 'settled' });
			expect(subNew?.error).toBeUndefined();
			expect(subOld).toMatchObject({ status: 'settled' });
			expect(subOld?.error).toBeUndefined();
		});
	});

	describe('dispatch queue admission', () => {
		it('returns the original receipt when the same dispatch is replayed', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);
			const queue = createNodeDispatchQueue(coordinator);

			const input = makeDispatchInput({ dispatchId: 'dispatch-replay' });
			const first = await queue.enqueue(input);
			await coordinator.waitForIdle();

			const replay = await queue.enqueue(input);
			expect(replay).toEqual(first);
			expect(replay).toEqual({ dispatchId: 'dispatch-replay', acceptedAt: input.acceptedAt });
		});

		it('throws when a dispatch id is replayed with a conflicting payload', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);
			const queue = createNodeDispatchQueue(coordinator);

			const input = makeDispatchInput({ dispatchId: 'dispatch-conflict' });
			await queue.enqueue(input);

			await expect(
				queue.enqueue(
					makeDispatchInput({ dispatchId: 'dispatch-conflict', input: { message: 'Different' } }),
				),
			).rejects.toThrow();
			await coordinator.waitForIdle();
		});
	});

	describe('session deletion resume across restart', () => {
		it('completes a crash-interrupted session deletion during reconciliation and unblocks admissions', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);
			const sessionKey = createSessionStorageKey('instance-1', 'default', 'default');
			await store.sessions.save(sessionKey, {
				version: 8,
				conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
				childSessions: [],
				entries: [],
				leafId: null,
				metadata: {},
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});

			// Simulate a crash mid-deletion: phase 1 durably writes the deletion
			// marker, then the process dies before the session tree is deleted.
			void store.submissions.deleteSession(sessionKey, () => new Promise<never>(() => {}));
			await new Promise((r) => setTimeout(r, 50));
			expect(await store.submissions.listPendingSessionDeletions()).toEqual([sessionKey]);
			// The orphaned marker blocks every admission for this session.
			await expect(store.submissions.admitDispatch(makeDispatchInput())).rejects.toThrow(
				'admission is unavailable while this session is being deleted',
			);

			// "Restart": a fresh coordinator resumes the deletion on reconcile.
			const provider = createFauxProvider();
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			expect(await executionStore.submissions.listPendingSessionDeletions()).toEqual([]);
			expect(await executionStore.sessions.load(sessionKey)).toBeNull();
			expect(await executionStore.submissions.admitDispatch(makeDispatchInput())).toMatchObject({
				kind: 'submission',
				submission: { status: 'queued' },
			});
		});
	});

	// ─── Direct prompt admission ────────────────────────────────────────────

	describe('direct prompt admission', () => {
		it('processes a direct prompt through the durable submission lifecycle', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Direct reply.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			const receipt = await admit({ message: 'Hello from direct prompt' });

			expect(receipt.submissionId).toEqual(expect.any(String));
			expect(receipt.result).toBeDefined();
			// The submission should be settled in the store.
			expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
		});

		it('appends the direct user message before assistant output', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Durable reply.')]);
			const executionStore = await openExecutionStore(dbPath);
			const eventStreamStore = createTestEventStreamStore();
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore,
			});

			const receipt = await coordinator
				.createAdmission('assistant', 'instance-1')({ message: 'Hello durable history' });
			const stream = await eventStreamStore.readEvents(agentStreamPath('assistant', 'instance-1'), {
				offset: '-1',
			});
			const events = stream.events.map((event) => event.data as Record<string, unknown>);
			const userIndex = events.findIndex(
				(event) => event.type === 'message_end' && (event.message as { role?: string }).role === 'user',
			);
			const assistantIndex = events.findIndex(
				(event) => event.type === 'message_end' && (event.message as { role?: string }).role === 'assistant',
			);

			expect(events[userIndex]).toMatchObject({
				type: 'message_end',
				submissionId: receipt.submissionId,
				message: {
					role: 'user',
					content: [{ type: 'text', text: 'Hello durable history' }],
				},
			});
			expect(userIndex).toBeGreaterThanOrEqual(0);
			expect(assistantIndex).toBeGreaterThan(userIndex);
		});

		it('continues a direct prompt when user event persistence fails', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Best-effort reply.')]);
			const executionStore = await openExecutionStore(dbPath);
			const eventStreamStore = createTestEventStreamStore();
			const originalAppend = eventStreamStore.appendEvent.bind(eventStreamStore);
			let failedUserAppend = false;
			eventStreamStore.appendEvent = async (path, event) => {
				if (
					!failedUserAppend &&
					(event as { type?: string; message?: { role?: string } }).type === 'message_end' &&
					(event as { message?: { role?: string } }).message?.role === 'user'
				) {
					failedUserAppend = true;
					throw new Error('event store unavailable');
				}
				return originalAppend(path, event);
			};
			const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore,
			});

			try {
				const receipt = await coordinator
					.createAdmission('assistant', 'instance-1')({ message: 'Hello best effort' });

				expect(receipt.result).toMatchObject({ text: 'Best-effort reply.' });
				expect(failedUserAppend).toBe(true);
				expect(consoleError).toHaveBeenCalledWith(
					'[flue:event-stream] Direct user event persistence failed before provider execution:',
					expect.any(Error),
				);
			} finally {
				consoleError.mockRestore();
			}
		});

		it('appends the terminal result before settling a direct prompt', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Terminal reply.')]);
			const executionStore = await openExecutionStore(dbPath);
			const eventStreamStore = createTestEventStreamStore();
			let terminalAppended = false;
			const originalAppend = eventStreamStore.appendEvent.bind(eventStreamStore);
			eventStreamStore.appendEvent = async (path, event) => {
				if ((event as { type?: string }).type === 'submission_settled') terminalAppended = true;
				return originalAppend(path, event);
			};
			const originalComplete = executionStore.submissions.completeSubmission.bind(
				executionStore.submissions,
			);
			executionStore.submissions.completeSubmission = async (attempt) => {
				expect(terminalAppended).toBe(true);
				return originalComplete(attempt);
			};
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore,
			});

			const receipt = await coordinator
				.createAdmission('assistant', 'instance-1')({ message: 'Hello terminal event' });
			const stream = await eventStreamStore.readEvents(agentStreamPath('assistant', 'instance-1'));
			const terminal = stream.events
				.map((event) => event.data as Record<string, unknown>)
				.find((event) => event.type === 'submission_settled');

			expect(terminal).toMatchObject({
				outcome: 'completed',
				submissionId: receipt.submissionId,
				result: { text: 'Terminal reply.' },
			});
		});

		it('persists direct prompt submission across store reopens', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Persisted direct reply.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			await admit({ message: 'Hello persisted' });

			// "Restart": open the same file with a fresh store and verify settled.
			const reopened = await openExecutionStore(dbPath);
			expect(await reopened.submissions.hasUnsettledSubmissions()).toBe(false);
		});

		it('forwards events to the attached observer during processing', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Event test reply.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const events: unknown[] = [];
			const admit = coordinator.createAdmission('assistant', 'instance-1');
			await admit({ message: 'Hello events' }, (event) => {
				events.push(event);
			});

			// Should have received at least one event during processing.
			expect(events.length).toBeGreaterThan(0);
			const submissionIds = new Set<string>();
			for (const event of events) {
				const e = event as Record<string, unknown>;
				expect(e.instanceId).toBe('instance-1');
				expect(e).not.toHaveProperty('runId');
				expect(e.submissionId).toEqual(expect.any(String));
				submissionIds.add(e.submissionId as string);
				if (e.type === 'message_start' || e.type === 'message_end') {
					expect(e.turnId).toEqual(expect.any(String));
				}
			}
			expect(submissionIds.size).toBe(1);
		});

		it('resolves the waiting direct prompt with the real result when completion settlement loses the attempt CAS', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Superseded but real reply.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			// Simulate another claimant superseding this attempt between
			// processing and settlement: the completion CAS reports a stale
			// attempt. The caller's completion promise must still resolve with
			// the real response instead of hanging forever.
			executionStore.submissions.completeSubmission = async () => false;

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			const receipt = await admit({ message: 'Hello superseded' });

			expect(receipt.result).toMatchObject({ text: 'Superseded but real reply.' });
		});

		it('queues concurrent same-session direct prompts instead of rejecting', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			// Need two responses since both prompts will be processed.
			provider.setResponses([
				fauxAssistantMessage('First reply.'),
				fauxAssistantMessage('Second reply.'),
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			// Fire both concurrently to the same session.
			const [result1, result2] = await Promise.all([
				admit({ message: 'First' }),
				admit({ message: 'Second' }),
			]);

			// Both should resolve (not reject).
			expect(result1).toBeDefined();
			expect(result2).toBeDefined();
			expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
		});
	});

	describe('direct prompt interrupt and recover', () => {
		it('requeues an interrupted direct prompt when canonical input is absent', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered direct reply.')]);
			const store = await openExecutionStore(dbPath);

			// Manually admit a direct submission and claim it without processing.
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-interrupted',
				agent: 'assistant',
				id: 'instance-1',
				payload: { message: 'Hello interrupted' },
				acceptedAt: new Date().toISOString(),
			});
			await store.submissions.claimSubmission({
				submissionId: 'direct-interrupted',
				attemptId: 'attempt-crashed',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			// Submission is running with no canonical input — simulates crash before input applied.

			// "Restart": new coordinator reconciles.
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission('direct-interrupted');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});

		it('terminalizes an interrupted direct prompt when input was applied but no response completed', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Should not run.')]);
			const store = await openExecutionStore(dbPath);

			// Admit, claim, and mark input applied — then "crash."
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-terminalized',
				agent: 'assistant',
				id: 'instance-1',
				payload: { message: 'Hello terminalized' },
				acceptedAt: new Date().toISOString(),
			});
			await store.submissions.claimSubmission({
				submissionId: 'direct-terminalized',
				attemptId: 'attempt-applied',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			await store.submissions.markSubmissionInputApplied({
				submissionId: 'direct-terminalized',
				attemptId: 'attempt-applied',
			});

			// "Restart": should terminalize because input was applied but no completed response.
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission('direct-terminalized');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});

		it('resolves a waiting direct prompt with the persisted result when reconciliation settles completed work', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const executionStore = await openExecutionStore(dbPath);
			const eventStreamStore = createTestEventStreamStore();
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore,
			});

			// Simulate an attempt that checkpointed a completed canonical
			// response and lost its lease before the settlement CAS: intercept
			// admission to claim with an already-expired lease and persist the
			// completed session, so this coordinator's expired-lease
			// reconciliation — not normal processing — settles the submission
			// while the caller is still awaiting completion.
			const originalAdmit = executionStore.submissions.admitDirect.bind(executionStore.submissions);
			executionStore.submissions.admitDirect = async (input) => {
				const admitted = await originalAdmit(input);
				await executionStore.submissions.claimSubmission({
					submissionId: input.submissionId,
					attemptId: 'attempt-lease-expired',
					ownerId: 'previous-owner',
					leaseExpiresAt: 1,
				});
				await executionStore.submissions.markSubmissionInputApplied({
					submissionId: input.submissionId,
					attemptId: 'attempt-lease-expired',
				});
				const storageKey = createSessionStorageKey('instance-1', 'default', 'default');
				const now = new Date().toISOString();
				await executionStore.sessions.save(storageKey, {
					version: 8,
					conversationId: 'conv_01KT3P3GZGFBCKHKMQ11A7H2HW',
				affinityKey: generateSessionAffinityKey(),
					childSessions: [],
					entries: [
						{
							type: 'message',
							id: 'e1',
							parentId: null,
							timestamp: now,
							message: {
								role: 'user',
								content: [{ type: 'text', text: 'Hello reconciled' }],
								timestamp: Date.now(),
							} as any,
							directSubmissionId: input.submissionId,
						},
						{
							type: 'message',
							id: 'e2',
							parentId: 'e1',
							timestamp: now,
							message: {
								role: 'assistant',
								content: [{ type: 'text', text: 'Completed canonical response.' }],
								stopReason: 'stop',
								api: 'test',
								provider: 'test',
								model: 'test-model',
								usage: {
									input: 0,
									output: 0,
									totalTokens: 0,
									cost: { input: 0, output: 0, total: 0 },
								},
								timestamp: Date.now(),
							} as any,
						},
					],
					leafId: 'e2',
					metadata: {},
					createdAt: now,
					updatedAt: now,
				});
				return admitted;
			};

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			const receipt = await admit({ message: 'Hello reconciled' });

			expect(receipt.result).toMatchObject({
				text: 'Completed canonical response.',
				model: { provider: 'test', id: 'test-model' },
			});
			expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
			// Reconciliation-driven settlement appends a durable event so
			// detached stream readers also observe the outcome.
			const stream = await eventStreamStore.readEvents(agentStreamPath('assistant', 'instance-1'));
			const settledEvents = stream.events
				.map((event) => event.data as Record<string, unknown>)
				.filter((event) => event.type === 'submission_settled');
			expect(settledEvents).toMatchObject([
				{
					outcome: 'completed',
					submissionId: receipt.submissionId,
					result: { text: 'Completed canonical response.' },
				},
			]);
		});

		it('rejects a waiting direct prompt with a typed interrupted error when reconciliation terminalizes it', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Should not be called.')]);
			const executionStore = await openExecutionStore(dbPath);
			const eventStreamStore = createTestEventStreamStore();
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				sessions: executionStore.sessions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
						})),
					},
				],
				createContext: makeFauxCreateContext(provider, executionStore),
				eventStreamStore,
			});

			// Simulate an attempt that lost its lease after recording input
			// application but before persisting any canonical work: intercept
			// admission to claim with an already-expired lease and mark input
			// applied, so this coordinator's expired-lease reconciliation —
			// not normal processing — terminalizes the submission while the
			// caller is still awaiting completion.
			const originalAdmit = executionStore.submissions.admitDirect.bind(executionStore.submissions);
			executionStore.submissions.admitDirect = async (input) => {
				const admitted = await originalAdmit(input);
				await executionStore.submissions.claimSubmission({
					submissionId: input.submissionId,
					attemptId: 'attempt-lease-expired',
					ownerId: 'previous-owner',
					leaseExpiresAt: 1,
				});
				await executionStore.submissions.markSubmissionInputApplied({
					submissionId: input.submissionId,
					attemptId: 'attempt-lease-expired',
				});
				return admitted;
			};

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			// The waiting caller rejects with the typed interrupted error —
			// the settled-submission error vocabulary is structured, not a
			// raw message string.
			const rejection = await admit({ message: 'Hello terminalized' }).then(
				() => undefined,
				(error: unknown) => error,
			);
			expect(rejection).toBeInstanceOf(SubmissionInterruptedError);
			expect(rejection).toMatchObject({
				type: 'submission_interrupted',
				meta: { phase: 'after_input_application' },
			});

			// Reconciliation-driven failure also appends a durable settlement
			// event so detached stream readers observe the outcome.
			const stream = await eventStreamStore.readEvents(agentStreamPath('assistant', 'instance-1'));
			const settledEvents = stream.events
				.map((event) => event.data as Record<string, unknown>)
				.filter((event) => event.type === 'submission_settled');
			expect(settledEvents).toMatchObject([
				{
					outcome: 'failed',
					submissionId: expect.any(String),
					error: {
						type: 'submission_interrupted',
						message: expect.any(String),
					},
				},
			]);
			expect(settledEvents[0]).toHaveProperty('submissionId');
		});

		it('silently recovers a direct prompt after restart with no attached observer', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered without observer.')]);
			const store = await openExecutionStore(dbPath);

			// Admit and claim without processing — simulates crash.
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-no-observer',
				agent: 'assistant',
				id: 'instance-1',
				payload: { message: 'Hello silent' },
				acceptedAt: new Date().toISOString(),
			});
			await store.submissions.claimSubmission({
				submissionId: 'direct-no-observer',
				attemptId: 'attempt-silent',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});

			// "Restart": no observer attached. Should still reconcile and settle.
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission('direct-no-observer');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});
	});

	// ─── Real Anthropic API smoke (integration) ─────────────────────────────
	// The one deliberately real-LLM test in this suite. It requires
	// ANTHROPIC_API_KEY (loaded from the repo-root .env), makes a paid network
	// call, and skips when no key is configured. Every durable coordinator
	// contract above is covered deterministically by the faux provider; this
	// exists only to smoke-test the lifecycle against a real provider.
	describe('real Anthropic API smoke', () => {
		it.skipIf(!hasApiKey)(
			'processes a dispatch through the full submission lifecycle against the real API',
			async () => {
				const dbPath = createTempDbPath();
				const { coordinator, executionStore } = await createRealCoordinator(dbPath);

				const input = makeDispatchInput();
				await coordinator.admitDispatch(input);
				await coordinator.waitForIdle();

				const submission = await executionStore.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
				expect(submission?.error).toBeUndefined();
			},
			30_000,
		);
	});

	describe('direct and dispatch same-session ordering', () => {
		it('queues a dispatch behind a same-session direct prompt until the direct settles', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);

			// Manually admit a direct submission and claim it to simulate an in-progress direct prompt.
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-head',
				agent: 'assistant',
				id: 'instance-1',
				payload: { message: 'Direct first' },
				acceptedAt: new Date().toISOString(),
			});
			await store.submissions.claimSubmission({
				submissionId: 'direct-head',
				attemptId: 'attempt-running',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});

			// Admit a dispatch to the same session.
			const dispatchInput = makeDispatchInput({
				dispatchId: 'dispatch-queued-behind',
			});
			await store.submissions.admitDispatch(dispatchInput);

			// The dispatch should be queued because the direct is the session head.
			const dispatch = await store.submissions.getSubmission(dispatchInput.dispatchId);
			expect(dispatch?.status).toBe('queued');

			// The direct is running — listRunnableSubmissions should NOT return the dispatch.
			const runnable = await store.submissions.listRunnableSubmissions();
			expect(runnable.find((s) => s.submissionId === 'dispatch-queued-behind')).toBeUndefined();
		});
	});
});
