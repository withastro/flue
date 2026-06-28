import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import { createFlueContext, type DispatchInput, resolveModel } from '../src/internal.ts';
import {
	createNodeAgentCoordinator,
	createNodeDispatchQueue,
	type NodeAgentCoordinator,
} from '../src/node/agent-coordinator.ts';
import { sqlite } from '../src/node/agent-execution-store.ts';
import type { ConversationStreamStore } from '../src/runtime/conversation-stream-store.ts';
import { agentStreamPath } from '../src/runtime/event-stream-store.ts';
import { handleAgentConversationRead } from '../src/runtime/handle-conversation-routes.ts';
import type { CreateAgentContextFn } from '../src/runtime/handle-agent.ts';
import { generateSessionAffinityKey } from '../src/runtime/ids.ts';
import { defineTool } from '../src/tool.ts';
import { createNoopSessionEnv } from './fixtures/session-env.ts';

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

async function killAtDurableBoundary(
	mode: 'input-marker' | 'stream-recovery' | 'tool-repair' | 'tool-outcome' | 'settlement',
	dbPath: string,
): Promise<void> {
	const child = fork(
		join(import.meta.dirname, 'fixtures', 'durable-boundary-child.mjs'),
		[mode, dbPath],
		{ stdio: ['ignore', 'ignore', 'inherit', 'ipc'] },
	);
	await new Promise<void>((resolve, reject) => {
		child.once('error', reject);
		child.once('exit', (code, signal) => {
			if (signal !== 'SIGKILL') reject(new Error(`Boundary child exited before kill (${code}, ${signal}).`));
		});
		child.once('message', (message) => {
			if (message !== 'ready') return;
			child.kill('SIGKILL');
			child.once('exit', () => resolve());
		});
	});
}

/** Open (or reopen) a file-backed execution store via the sqlite() adapter. */
async function openExecutionStore(dbPath: string): Promise<AgentExecutionStore> {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { executionStore } = await adapter.connect();
	return executionStore;
}

/** Create a context factory that uses a real LLM model. */
function makeRealCreateContext(): CreateAgentContextFn {
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
		});
}

/** Create a context factory that uses a faux (mock) provider. */
function makeFauxCreateContext(
	provider: FauxProviderRegistration,
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
	const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
	const agent = defineAgent(() => ({ model: REAL_MODEL }));
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		agents: [{ name: 'assistant', definition: agent }],
		createContext: makeRealCreateContext(),
		conversationStreamStore,
		attachmentStore,
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
	const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
	const agent = defineAgent(() => ({
		model: `${provider.getModel().provider}/${provider.getModel().id}`,
		durability,
	}));
	const coordinator = createNodeAgentCoordinator({
		submissions: executionStore.submissions,
		agents: [{ name: 'assistant', definition: agent }],
		createContext: makeFauxCreateContext(provider),
		conversationStreamStore,
		attachmentStore,
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
		const providerMessages: string[][] = [];
		provider.setResponses([(context) => {
			providerMessages.push(context.messages.map((message) =>
				typeof message.content === 'string'
					? message.content
					: message.content.map((block) => ('text' in block ? block.text : block.type)).join('\n'),
			));
			return fauxAssistantMessage('Hello back');
		}]);
		const { coordinator } = await createFauxCoordinator(dbPath, provider);
		const input = makeDispatchInput({
			dispatchId: 'dispatch-semantic-input',
			input: { z: '<later>', a: { value: '&first' } },
			acceptedAt: '2026-06-26T12:00:00.000Z',
		});

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
		expect(inputRecord).toMatchObject({
			dispatchId: input.dispatchId,
			signalType: 'dispatch_input',
			tagName: 'dispatch',
			content: '{\n  "a": {\n    "value": "&first"\n  },\n  "z": "<later>"\n}',
			attributes: {
				agent: 'assistant',
				id: 'instance-1',
				session: 'default',
				dispatchId: 'dispatch-semantic-input',
				acceptedAt: '2026-06-26T12:00:00.000Z',
			},
		});
		expect(providerMessages).toEqual([[
			'<dispatch type="dispatch_input" agent="assistant" id="instance-1" session="default" dispatchId="dispatch-semantic-input" acceptedAt="2026-06-26T12:00:00.000Z">\n{\n  "a": {\n    "value": "&amp;first"\n  },\n  "z": "&lt;later&gt;"\n}\n</dispatch>',
		]]);
		expect(assistantRecord).toMatchObject({ parentId: inputRecord?.type === 'signal' ? inputRecord.messageId : undefined });

		await coordinator.shutdown();
	});

	it('rebuilds canonical state without an automatic full-log snapshot', async () => {
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
		const { conversationStreamStore } = await adapter.connect();
		const path = agentStreamPath('assistant', 'instance-1');
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

		it('recovers on the same coordinator after a terminal append generation fails', async () => {
			const dbPath = createTempDbPath();
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered admission.')]);
			const append = conversationStreamStore.append.bind(conversationStreamStore);
			let remainingFailures = 2;
			const failingStore: ConversationStreamStore = {
				...conversationStreamStore,
				createStream: conversationStreamStore.createStream.bind(conversationStreamStore),
				acquireProducer: conversationStreamStore.acquireProducer.bind(conversationStreamStore),
				append: async (input) => {
					if (remainingFailures-- > 0) throw new Error('transient append failure');
					return append(input);
				},
				read: conversationStreamStore.read.bind(conversationStreamStore),
				getMeta: conversationStreamStore.getMeta.bind(conversationStreamStore),
				delete: conversationStreamStore.delete.bind(conversationStreamStore),
				subscribe: conversationStreamStore.subscribe.bind(conversationStreamStore),
			};
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [{
					name: 'assistant',
					definition: defineAgent(() => ({
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					})),
				}],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore: failingStore,
				attachmentStore,
			});
			const input = makeDispatchInput({ dispatchId: 'dispatch-writer-recovery' });

			await expect(coordinator.admitDispatch(input)).rejects.toThrow('transient append failure');
			await coordinator.reconcileSubmissions();

			expect(await executionStore.submissions.getSubmission(input.dispatchId)).toMatchObject({
				status: 'settled',
				canonicalReadyAt: expect.any(Number),
			});
			const records = (await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1')))
				.batches.flatMap((batch) => batch.records);
			expect(records.filter((record) => record.type === 'conversation_created')).toHaveLength(1);
			expect(records.filter((record) => record.type === 'signal')).toHaveLength(1);
		});

		it('recovers an admitted submission whose canonical readiness was not marked', async () => {
			const dbPath = createTempDbPath();
			const store = await openExecutionStore(dbPath);
			const input = makeDispatchInput();
			await store.submissions.admitDispatch(input);

			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Recovered admission.')]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			expect(await executionStore.submissions.getSubmission(input.dispatchId)).toMatchObject({
				status: 'settled',
				canonicalReadyAt: expect.any(Number),
			});
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
		it('repairs canonical input after a real process kill before the input marker', async () => {
			const dbPath = createTempDbPath();
			await killAtDurableBoundary('input-marker', dbPath);
			let providerCalls = 0;
			const provider = createFauxProvider();
			provider.setResponses([() => {
				providerCalls += 1;
				return fauxAssistantMessage('Recovered after kill.');
			}]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			await coordinator.reconcileSubmissions();

			expect(providerCalls).toBe(1);
			expect(await executionStore.submissions.getSubmission('dispatch-input-marker')).toMatchObject({
				status: 'settled',
				inputAppliedAt: expect.any(Number),
			});
		});

		// Kill matrix scenario 3: killed after acknowledged partial deltas,
		// before completion. Recovery must materialize the durable partial
		// exactly once (never re-stream committed text) and resume with at most
		// one replacement provider call.
		it('materializes a durable partial stream once and resumes after a real process kill', async () => {
			const dbPath = createTempDbPath();
			await killAtDurableBoundary('stream-recovery', dbPath);
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
			let providerCalls = 0;
			const provider = createFauxProvider();
			provider.setResponses([() => {
				providerCalls += 1;
				return fauxAssistantMessage('Continued after recovery.');
			}]);
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [{
					name: 'assistant',
					definition: defineAgent(() => ({
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
					})),
				}],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore,
				attachmentStore,
			});

			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			// Recovery itself dispatches no provider work; only the resumed
			// continuation calls the provider.
			expect(providerCalls).toBe(1);
			const records = (await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1')))
				.batches.flatMap((batch) => batch.records);
			// The committed partial text is materialized exactly once — never re-streamed.
			expect(records.filter(
				(record) => record.type === 'assistant_text_delta' && record.delta === 'Durable partial',
			)).toHaveLength(1);
			expect(await executionStore.submissions.getSubmission('dispatch-stream-recovery')).toMatchObject({
				status: 'settled',
			});
		});

		it('reuses a completed parallel tool outcome after a real process kill before graph materialization', async () => {
			const dbPath = createTempDbPath();
			await killAtDurableBoundary('tool-outcome', dbPath);
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Continued after repair.')]);
			let toolCalls = 0;
			const lookup = defineTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({}),
				run: async () => {
					toolCalls += 1;
					return 'must not run';
				},
			});
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [{
					name: 'assistant',
					definition: defineAgent(() => ({
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
						tools: [lookup],
					})),
				}],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore,
						attachmentStore,
			});

			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			expect(toolCalls).toBe(0);
			const records = (await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1')))
				.batches.flatMap((batch) => batch.records);
			const outcomes = records.filter((record) => record.type === 'tool_outcome');
			expect(outcomes).toHaveLength(2);
			expect(outcomes[0]).toMatchObject({
				toolCallId: 'tool-call-1',
				isError: false,
				content: [{ type: 'text', text: 'Known completed result' }],
			});
			expect(outcomes[1]).toMatchObject({
				toolCallId: 'tool-call-2',
				isError: true,
			});
			expect(records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(1);
		});

		// Kill matrix scenario 1 (the most important): killed after a tool turn
		// was made durable but before ANY tool outcome was recorded. Recovery
		// must write one explicit unknown-outcome error, commit the batch, and
		// NEVER re-run the tool.
		it('writes one unknown-outcome error and never re-runs a tool interrupted before any outcome', async () => {
			const dbPath = createTempDbPath();
			await killAtDurableBoundary('tool-repair', dbPath);
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Continued after repair.')]);
			let toolCalls = 0;
			const lookup = defineTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({}),
				run: async () => {
					toolCalls += 1;
					return 'must not run';
				},
			});
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [{
					name: 'assistant',
					definition: defineAgent(() => ({
						model: `${provider.getModel().provider}/${provider.getModel().id}`,
						tools: [lookup],
					})),
				}],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore,
				attachmentStore,
			});

			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			expect(toolCalls).toBe(0);
			const records = (await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1')))
				.batches.flatMap((batch) => batch.records);
			const outcomes = records.filter(
				(record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-1',
			);
			expect(outcomes).toHaveLength(1);
			expect(outcomes[0]).toMatchObject({ toolCallId: 'tool-call-1', isError: true });
			expect(records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(1);
		});

		it('finalizes canonical settlement after a real process kill before operational finalization', async () => {
			const dbPath = createTempDbPath();
			await killAtDurableBoundary('settlement', dbPath);
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore } = await adapter.connect();
			const obligations = await executionStore.submissions.listPendingSubmissionSettlements();
			expect(obligations).toHaveLength(1);
			const obligation = obligations[0];
			if (!obligation) throw new Error('Expected settlement obligation.');
			expect(await executionStore.submissions.finalizeSubmissionSettlement(
				{ submissionId: obligation.submissionId, attemptId: obligation.attemptId },
				obligation.recordId,
			)).toBe(true);
			const records = (await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1')))
				.batches.flatMap((batch) => batch.records);
			expect(records.filter((record) => record.id === obligation.recordId)).toHaveLength(1);
		});

		it('repairs the input marker when canonical input committed before the marker', async () => {
			const dbPath = createTempDbPath();
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore } = await adapter.connect();
			const input = makeDispatchInput({ dispatchId: 'dispatch-input-marker' });
			await executionStore.submissions.admitDispatch(input);
			await executionStore.submissions.markSubmissionCanonicalReady(input.dispatchId);
			await executionStore.submissions.claimSubmission({
				submissionId: input.dispatchId,
				attemptId: 'attempt-before-marker',
				ownerId: 'test-owner',
				leaseExpiresAt: 1,
			});
			const path = agentStreamPath(input.agent, input.id);
			await conversationStreamStore.createStream(path, { agentName: input.agent, instanceId: input.id });
			const claim = await conversationStreamStore.acquireProducer(path, 'crashed-owner');
			const timestamp = new Date().toISOString();
			await conversationStreamStore.append({
				path,
				producerId: claim.producerId,
				producerEpoch: claim.producerEpoch,
				incarnation: claim.incarnation,
				producerSequence: claim.nextProducerSequence,
				submission: { submissionId: input.dispatchId, attemptId: 'attempt-before-marker' },
				records: [
					{
						v: 1,
						id: 'record-conversation-created',
						type: 'conversation_created',
						kind: 'root',
						conversationId: 'conversation-input-marker',
						harness: 'default',
						session: 'default',
						timestamp,
						affinityKey: generateSessionAffinityKey(),
						createdAt: timestamp,
					},
					{
						v: 1,
						id: `record_dispatch_input_${input.dispatchId}`,
						type: 'signal',
						conversationId: 'conversation-input-marker',
						harness: 'default',
						session: 'default',
						timestamp,
						submissionId: input.dispatchId,
						attemptId: 'attempt-before-marker',
						dispatchId: input.dispatchId,
						messageId: 'entry_dispatch_ZGlzcGF0Y2gtaW5wdXQtbWFya2Vy',
						parentId: null,
						signalType: 'dispatch_input',
						tagName: 'dispatch',
						content: '{\n  "message": "Hello"\n}',
						attributes: {
							agent: input.agent,
							id: input.id,
							session: 'default',
							dispatchId: input.dispatchId,
							acceptedAt: input.acceptedAt,
						},
					},
				],
			});

			let providerCalls = 0;
			const provider = createFauxProvider();
			provider.setResponses([() => {
				providerCalls += 1;
				return fauxAssistantMessage('Recovered reply.');
			}]);
			const { coordinator, executionStore: recoveredStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();

			expect(providerCalls).toBe(1);
			expect(await recoveredStore.submissions.getSubmission(input.dispatchId)).toMatchObject({
				status: 'settled',
				inputAppliedAt: expect.any(Number),
			});
		});

		it('reconciles an interrupted submission by requeuing when canonical input is absent', async () => {
			const dbPath = createTempDbPath();
			// First process will be "interrupted" — we manually admit+claim without processing.
			const store1 = await openExecutionStore(dbPath);
			const input = makeDispatchInput();
			await store1.submissions.admitDispatch(input);
			await store1.submissions.markSubmissionCanonicalReady(input.dispatchId);
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
			await store1.submissions.markSubmissionCanonicalReady(input.dispatchId);
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

	describe('tool-use turns', () => {
		it('records each tool outcome before committing the batch during a tool-use turn', async () => {
			const dbPath = createTempDbPath();
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
			const provider = createFauxProvider();
			const toolCallId = `tool:outcome-${crypto.randomUUID()}`;
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
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [
					{
						name: 'assistant',
						definition: defineAgent(() => ({
							model: `${provider.getModel().provider}/${provider.getModel().id}`,
							tools: [lookup],
						})),
					},
				],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore,
				attachmentStore,
			});

			const input = makeDispatchInput({ dispatchId: 'dispatch:tool-outcome-order' });
			await coordinator.admitDispatch(input);
			await coordinator.waitForIdle();

			const records = (await conversationStreamStore.read(
				agentStreamPath(input.agent, input.id),
			)).batches.flatMap((batch) => batch.records);
			const outcomeIndex = records.findIndex(
				(record) => record.type === 'tool_outcome' && record.toolCallId === toolCallId,
			);
			const commitIndex = records.findIndex(
				(record) => record.type === 'tool_results_committed' && record.assistantMessageId,
			);
			expect(outcomeIndex).toBeGreaterThanOrEqual(0);
			expect(commitIndex).toBeGreaterThan(outcomeIndex);
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
			await store.submissions.markSubmissionCanonicalReady(inputA.dispatchId);
			await store.submissions.admitDispatch(inputB);
			await store.submissions.markSubmissionCanonicalReady(inputB.dispatchId);

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
			await store.submissions.markSubmissionCanonicalReady(inputOld.dispatchId);

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

	// ─── Direct prompt admission ────────────────────────────────────────────

		describe('direct prompt admission', () => {
		it('materializes the canonical conversation before detached admission returns', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Later reply.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const receipt = await coordinator
				.createAdmission('assistant', 'instance-1')({ message: 'Hello' }, undefined, false);
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { conversationStreamStore } = await adapter.connect();
			const read = await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1'));
			const records = read.batches.flatMap((batch) => batch.records);

			expect(receipt.submissionId).toEqual(expect.any(String));
			expect(records).toEqual([
				expect.objectContaining({
					type: 'conversation_created',
					harness: 'default',
					session: 'default',
				}),
			]);
		});

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

		it('replays the direct prompt user message through the public conversation history', async () => {
			// Regression for the durable-stream contract (#368/#307): a direct
			// prompt's user message must survive in the materialized history read —
			// what a client rebuilds from after a page refresh — and carry the
			// submission id so an optimistic local message can be reconciled.
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Direct reply.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const receipt = await coordinator.createAdmission('assistant', 'instance-1')({
				message: 'Hello from direct prompt',
			});

			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { conversationStreamStore } = await adapter.connect();
			const response = await handleAgentConversationRead({
				store: conversationStreamStore,
				path: agentStreamPath('assistant', 'instance-1'),
				request: new Request('https://flue.test/agents/assistant/instance-1?view=history'),
			});
			const snapshot = (await response.json()) as {
				messages: { role: string; submissionId?: string; parts: unknown[] }[];
			};

			const userMessage = snapshot.messages.find((message) => message.role === 'user');
			expect(userMessage).toMatchObject({
				role: 'user',
				submissionId: receipt.submissionId,
				parts: [{ type: 'text', text: 'Hello from direct prompt', state: 'done' }],
			});
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
			await store.submissions.markSubmissionCanonicalReady('direct-interrupted');
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
			await store.submissions.markSubmissionCanonicalReady('direct-terminalized');
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
			await store.submissions.markSubmissionCanonicalReady('direct-no-observer');
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
			await store.submissions.markSubmissionCanonicalReady('direct-head');
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
});
