import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import { afterEach, describe, expect, it } from 'vite-plus/test';
import { join } from 'node:path';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createAgent } from '../src/agent-definition.ts';
import { createFlueContext, resolveModel, type DispatchInput } from '../src/internal.ts';
import { createNodeAgentExecutionStore } from '../src/node/agent-execution-store.ts';
import {
	createNodeAgentCoordinator,
	type NodeAgentCoordinator,
} from '../src/node/agent-coordinator.ts';
import type { CreateContextFn } from '../src/runtime/handle-agent.ts';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import { createSessionStorageKey } from '../src/session-identity.ts';
import { generateSessionAffinityKey } from '../src/runtime/ids.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

// ---------------------------------------------------------------------------
// Env setup — load ANTHROPIC_API_KEY from the repo .env file
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

/** Create a context factory that uses a real LLM model. */
function makeRealCreateContext(executionStore: AgentExecutionStore): CreateContextFn {
	const model = resolveModel(REAL_MODEL);
	return (id, runId, payload, req, initialEventIndex, dispatchId) =>
		createFlueContext({
			id,
			runId,
			dispatchId,
			payload,
			env: {},
			req,
			initialEventIndex,
			agentConfig: {
				systemPrompt: 'You are a test assistant. Respond with a single short sentence.',
				skills: {},
				subagents: {},
				model,
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
): CreateContextFn {
	return (id, runId, payload, req, initialEventIndex, dispatchId) =>
		createFlueContext({
			id,
			runId,
			dispatchId,
			payload,
			env: {},
			req,
			initialEventIndex,
			agentConfig: {
				systemPrompt: '',
				skills: {},
				subagents: {},
				model: undefined,
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
		session: 'default',
		input: { message: 'Hello' },
		acceptedAt: new Date().toISOString(),
		...overrides,
	};
}

/** Create a coordinator backed by a real LLM. */
function createRealCoordinator(dbPath: string): {
	coordinator: NodeAgentCoordinator;
	executionStore: AgentExecutionStore;
} {
	const executionStore = createNodeAgentExecutionStore(dbPath);
	const agent = createAgent(() => ({ model: REAL_MODEL }));
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		agents: { assistant: agent },
		createContext: makeRealCreateContext(executionStore),
	});
	return { coordinator, executionStore };
}

/** Create a coordinator backed by a faux (mock) provider. */
function createFauxCoordinator(
	dbPath: string,
	provider: FauxProviderRegistration,
	durability?: { retry?: number; timeout?: number },
): { coordinator: NodeAgentCoordinator; executionStore: AgentExecutionStore } {
	const executionStore = createNodeAgentExecutionStore(dbPath);
	const agent = createAgent(() => ({
		model: `${provider.getModel().provider}/${provider.getModel().id}`,
		durability,
	}));
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		agents: { assistant: agent },
		createContext: makeFauxCreateContext(provider, executionStore),
	});
	return { coordinator, executionStore };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('NodeAgentCoordinator', () => {
	describe('basic lifecycle', () => {
		it.skipIf(!hasApiKey)(
			'processes a dispatch through the full submission lifecycle with file persistence',
			async () => {
				const dbPath = createTempDbPath();
				const { coordinator, executionStore } = createRealCoordinator(dbPath);

				const input = makeDispatchInput();
				await coordinator.admitDispatch(input);
				await coordinator.waitForIdle();

				const submission = await executionStore.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
				expect(submission?.error).toBeUndefined();
			},
			30_000,
		);

		it.skipIf(!hasApiKey)(
			'persists settled submission across store reopens',
			async () => {
				const dbPath = createTempDbPath();
				const { coordinator } = createRealCoordinator(dbPath);

				const input = makeDispatchInput();
				await coordinator.admitDispatch(input);
				await coordinator.waitForIdle();

				// "Restart": open the same file with a fresh store.
				const reopened = createNodeAgentExecutionStore(dbPath);
				const submission = await reopened.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled', kind: 'dispatch' });
				expect(submission?.error).toBeUndefined();
				expect(await reopened.submissions.hasUnsettledSubmissions()).toBe(false);
			},
			30_000,
		);
	});

	describe('interrupt and recover', () => {
		it.skipIf(!hasApiKey)(
			'reconciles an interrupted submission by requeuing when canonical input is absent',
			async () => {
				const dbPath = createTempDbPath();
				// First process will be "interrupted" — we manually admit+claim without processing.
				const store1 = createNodeAgentExecutionStore(dbPath);
				const input = makeDispatchInput();
				await store1.submissions.admitDispatch(input);
				await store1.submissions.claimSubmission({
					submissionId: input.dispatchId,
					attemptId: 'attempt-interrupted',
					ownerId: 'test-owner',
					leaseExpiresAt: 1,
				});
				// Submission is now running with no canonical input — simulates crash before input applied.

				// "Restart": new coordinator reconciles with a real LLM.
				const { coordinator, executionStore } = createRealCoordinator(dbPath);
				await coordinator.reconcileSubmissions();

				const submission = await executionStore.submissions.getSubmission(input.dispatchId);
				expect(submission).toMatchObject({ status: 'settled' });
				expect(submission?.error).toBeUndefined();
			},
			30_000,
		);

		it('terminalizes an interrupted submission when input was applied but no response completed', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Complete response.')]);

			// Process fully, then simulate an interrupted second dispatch to same session.
			const { coordinator: coord1, executionStore: store1 } = createFauxCoordinator(
				dbPath,
				provider,
			);
			const input1 = makeDispatchInput({ dispatchId: 'dispatch-first', session: 'sess-1' });
			await coord1.admitDispatch(input1);
			await coord1.waitForIdle();

			// Now manually admit+claim a second dispatch without processing — leave running.
			const input2 = makeDispatchInput({ dispatchId: 'dispatch-second', session: 'sess-1' });
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
			const { coordinator: coord2, executionStore: store2 } = createFauxCoordinator(
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
	});

	describe('attempt exhaustion', () => {
		it('terminalizes a submission after exceeding the retry budget', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = createNodeAgentExecutionStore(dbPath);

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
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toContain('exceeded maximum recovery attempts');
		});
	});

	describe('timeout', () => {
		it('persists configured durability when input is applied', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider, {
				retry: 3,
				timeout: 120,
			});

			const input = makeDispatchInput();
			await coordinator.admitDispatch(input);
			await coordinator.waitForIdle();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission?.maxRetry).toBe(3);
			expect(submission?.timeoutAt).toBeGreaterThanOrEqual(
				(submission?.startedAt ?? 0) + 120 * 60_000,
			);
		});

		it('terminalizes a submission after the configured timeout expires', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			const store = createNodeAgentExecutionStore(dbPath);

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
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toContain('exceeded configured timeout');
		});
	});

	describe('tool repair across restart', () => {
		it('continues from canonical tool results when the journal is still tool_request_recorded after restart', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Completed after preserved tool result.')]);
			const store = createNodeAgentExecutionStore(dbPath);
			const input = makeDispatchInput({ session: 'tool-result-session' });
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
			const storageKey = createSessionStorageKey('instance-1', 'default', 'tool-result-session');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 5,
				affinityKey: generateSessionAffinityKey(),
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Run the tool.', timestamp: Date.now() } as any,
						source: 'dispatch',
						dispatch: {
							dispatchId: input.dispatchId,
							agent: 'assistant',
							id: 'instance-1',
							session: 'tool-result-session',
							acceptedAt: now,
							input: { message: 'Hello' },
						},
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

			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
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
			const store = createNodeAgentExecutionStore(dbPath);
			const input = makeDispatchInput({ session: 'tool-repair-session' });
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
			const storageKey = createSessionStorageKey('instance-1', 'default', 'tool-repair-session');
			const now = new Date().toISOString();
			await store.sessions.save(storageKey, {
				version: 5,
				affinityKey: generateSessionAffinityKey(),
				entries: [
					{
						type: 'message',
						id: 'e1',
						parentId: null,
						timestamp: now,
						message: { role: 'user', content: 'Run the tools.', timestamp: Date.now() } as any,
						source: 'dispatch',
						dispatch: {
							dispatchId: input.dispatchId,
							agent: 'assistant',
							id: 'instance-1',
							session: 'tool-repair-session',
							acceptedAt: now,
							input: { message: 'Hello' },
						},
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
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission(input.dispatchId);
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});
	});

	describe('queue ordering across restart', () => {
		it.skipIf(!hasApiKey)(
			'reconciles the interrupted submission before processing queued work in the same session',
			async () => {
				const dbPath = createTempDbPath();
				const store = createNodeAgentExecutionStore(dbPath);

				// Admit two dispatches to the same session.
				const inputA = makeDispatchInput({ dispatchId: 'dispatch-A', session: 'ordered-session' });
				const inputB = makeDispatchInput({ dispatchId: 'dispatch-B', session: 'ordered-session' });
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
				// then process A, then drain B. Both use a real LLM.
				const { coordinator, executionStore } = createRealCoordinator(dbPath);
				await coordinator.reconcileSubmissions();
				await coordinator.waitForIdle();

				const subA = await executionStore.submissions.getSubmission(inputA.dispatchId);
				const subB = await executionStore.submissions.getSubmission(inputB.dispatchId);
				expect(subA).toMatchObject({ status: 'settled' });
				expect(subA?.error).toBeUndefined();
				expect(subB).toMatchObject({ status: 'settled' });
				expect(subB?.error).toBeUndefined();
				expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
			},
			60_000,
		);

		it.skipIf(!hasApiKey)(
			'processes queued submissions from different sessions independently',
			async () => {
				const dbPath = createTempDbPath();
				const { coordinator, executionStore } = createRealCoordinator(dbPath);

				const inputA = makeDispatchInput({ dispatchId: 'dispatch-sessA', session: 'session-A' });
				const inputB = makeDispatchInput({ dispatchId: 'dispatch-sessB', session: 'session-B' });

				await coordinator.admitDispatch(inputA);
				await coordinator.admitDispatch(inputB);
				await coordinator.waitForIdle();

				const subA = await executionStore.submissions.getSubmission(inputA.dispatchId);
				const subB = await executionStore.submissions.getSubmission(inputB.dispatchId);
				expect(subA).toMatchObject({ status: 'settled' });
				expect(subA?.error).toBeUndefined();
				expect(subB).toMatchObject({ status: 'settled' });
				expect(subB?.error).toBeUndefined();
			},
			60_000,
		);
	});

	describe('queue drain after dispatch', () => {
		it.skipIf(!hasApiKey)(
			'drains queued submissions after processing a new dispatch',
			async () => {
				const dbPath = createTempDbPath();
				const store = createNodeAgentExecutionStore(dbPath);

				// Pre-queue a submission from a "previous process" that was never claimed.
				const inputOld = makeDispatchInput({
					dispatchId: 'dispatch-old',
					session: 'drain-session',
				});
				await store.submissions.admitDispatch(inputOld);

				// Now create a fresh coordinator and dispatch a new submission to a different session.
				const { coordinator, executionStore } = createRealCoordinator(dbPath);

				const inputNew = makeDispatchInput({
					dispatchId: 'dispatch-new',
					session: 'other-session',
				});
				await coordinator.admitDispatch(inputNew);
				await coordinator.waitForIdle();

				// Both should be settled: the new one from direct processing, the old one from drain.
				const subOld = await executionStore.submissions.getSubmission(inputOld.dispatchId);
				const subNew = await executionStore.submissions.getSubmission(inputNew.dispatchId);
				expect(subNew).toMatchObject({ status: 'settled' });
				expect(subNew?.error).toBeUndefined();
				expect(subOld).toMatchObject({ status: 'settled' });
				expect(subOld?.error).toBeUndefined();
			},
			60_000,
		);
	});

	// ─── Direct prompt admission ────────────────────────────────────────────

	describe('direct prompt admission', () => {
		it('processes a direct prompt through the durable submission lifecycle', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Direct reply.')]);
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			const result = await admit({ message: 'Hello from direct prompt' });

			expect(result).toBeDefined();
			// The submission should be settled in the store.
			expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
		});

		it('persists direct prompt submission across store reopens', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Persisted direct reply.')]);
			const { coordinator } = createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			await admit({ message: 'Hello persisted' });

			// "Restart": open the same file with a fresh store and verify settled.
			const reopened = createNodeAgentExecutionStore(dbPath);
			expect(await reopened.submissions.hasUnsettledSubmissions()).toBe(false);
		});

		it('forwards events to the attached observer during processing', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Event test reply.')]);
			const { coordinator } = createFauxCoordinator(dbPath, provider);

			const events: unknown[] = [];
			const admit = coordinator.createAdmission('assistant', 'instance-1');
			await admit({ message: 'Hello events' }, (event) => {
				events.push(event);
			});

			// Should have received at least one event during processing.
			expect(events.length).toBeGreaterThan(0);
			// Events should have instanceId set and no runId.
			for (const event of events) {
				const e = event as Record<string, unknown>;
				expect(e.instanceId).toBe('instance-1');
				expect(e).not.toHaveProperty('runId');
			}
		});

		it('queues concurrent same-session direct prompts instead of rejecting', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			// Need two responses since both prompts will be processed.
			provider.setResponses([
				fauxAssistantMessage('First reply.'),
				fauxAssistantMessage('Second reply.'),
			]);
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			// Fire both concurrently to the same session.
			const [result1, result2] = await Promise.all([
				admit({ message: 'First', session: 'concurrent-session' }),
				admit({ message: 'Second', session: 'concurrent-session' }),
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
			const store = createNodeAgentExecutionStore(dbPath);

			// Manually admit a direct submission and claim it without processing.
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-interrupted',
				agent: 'assistant',
				id: 'instance-1',
				session: 'default',
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
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission('direct-interrupted');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});

		it('terminalizes an interrupted direct prompt when input was applied but no response completed', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Should not run.')]);
			const store = createNodeAgentExecutionStore(dbPath);

			// Admit, claim, and mark input applied — then "crash."
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-terminalized',
				agent: 'assistant',
				id: 'instance-1',
				session: 'default',
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
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission('direct-terminalized');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeDefined();
		});

		it('silently recovers a direct prompt after restart with no attached observer', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered without observer.')]);
			const store = createNodeAgentExecutionStore(dbPath);

			// Admit and claim without processing — simulates crash.
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-no-observer',
				agent: 'assistant',
				id: 'instance-1',
				session: 'silent-session',
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
			const { coordinator, executionStore } = createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			const submission = await executionStore.submissions.getSubmission('direct-no-observer');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeUndefined();
		});
	});

	describe('direct and dispatch same-session ordering', () => {
		it('queues a dispatch behind a same-session direct prompt until the direct settles', async () => {
			const dbPath = createTempDbPath();
			const store = createNodeAgentExecutionStore(dbPath);

			// Manually admit a direct submission and claim it to simulate an in-progress direct prompt.
			await store.submissions.admitDirect({
				kind: 'direct',
				submissionId: 'direct-head',
				agent: 'assistant',
				id: 'instance-1',
				session: 'ordered-mixed',
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
				session: 'ordered-mixed',
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
