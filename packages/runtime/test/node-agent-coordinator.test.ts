import { fork } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	type FauxProviderRegistration,
	fauxAssistantMessage,
	fauxToolCall,
	registerFauxProvider,
} from '@earendil-works/pi-ai/compat';
import * as v from 'valibot';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineAgent } from '../src/agent-definition.ts';
import type { AgentExecutionStore } from '../src/agent-execution-store.ts';
import type { ConversationRecord } from '../src/conversation-records.ts';
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
	mode: 'input-marker' | 'stream-recovery' | 'tool-repair' | 'tool-outcome' | 'settlement' | 'child-tool-repair',
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
		message: { kind: 'signal', type: 'test.event', body: 'Hello' },
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

/**
 * Seed a running-but-abandoned submission (expired lease, crashed owner)
 * whose canonical conversation was left dangling. Shapes:
 * - 'task-call': a durable toolUse turn with one unresolved `task` call and a
 *   retained child conversation (no outcome, no commit).
 * - 'partial-batch': a durable toolUse turn with two `lookup` calls, one
 *   outcome recorded, none committed.
 * - 'ghost-start': an in-progress assistant started before any output was
 *   persisted.
 * - 'ghost-stream': an in-progress assistant stream (started + one durable
 *   delta) never completed.
 */
async function seedDanglingSubmission(options: {
	dbPath: string;
	dispatchId: string;
	shape: 'task-call' | 'partial-batch' | 'ghost-start' | 'ghost-stream';
	durability?: { maxRetry: number; timeoutAt: number };
}): Promise<{ conversationId: string; childConversationId?: string }> {
	const adapter = sqlite(options.dbPath);
	await adapter.migrate?.();
	const { executionStore, conversationStreamStore } = await adapter.connect();
	const input = makeDispatchInput({ dispatchId: options.dispatchId });
	const attemptId = `attempt-${options.dispatchId}`;
	await executionStore.submissions.admitDispatch(input);
	await executionStore.submissions.markSubmissionCanonicalReady(input.dispatchId);
	await executionStore.submissions.claimSubmission({
		submissionId: input.dispatchId,
		attemptId,
		ownerId: 'crashed-owner',
		leaseExpiresAt: 1,
	});
	const path = agentStreamPath(input.agent, input.id);
	await conversationStreamStore.createStream(path, {
		agentName: input.agent,
		instanceId: input.id,
	});
	const claim = await conversationStreamStore.acquireProducer(path, 'crashed-owner');
	let producerSequence = claim.nextProducerSequence;
	const append = (records: ConversationRecord[]) =>
		conversationStreamStore.append({
			path,
			producerId: claim.producerId,
			producerEpoch: claim.producerEpoch,
			incarnation: claim.incarnation,
			producerSequence: producerSequence++,
			submission: { submissionId: input.dispatchId, attemptId },
			records,
		});
	const conversationId = `conversation-${options.dispatchId}`;
	const timestamp = new Date().toISOString();
	const scope = {
		v: 1 as const,
		conversationId,
		harness: 'default',
		session: 'default',
		timestamp,
		submissionId: input.dispatchId,
		attemptId,
	};
	const inputEntryId = `entry_dispatch_${Buffer.from(input.dispatchId).toString('base64url')}`;
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	await append([
		{
			v: 1,
			id: `record-created-${options.dispatchId}`,
			type: 'conversation_created',
			kind: 'root',
			conversationId,
			harness: 'default',
			session: 'default',
			timestamp,
			affinityKey: generateSessionAffinityKey(),
			createdAt: timestamp,
		},
		{
			...scope,
			id: `record_dispatch_input_${input.dispatchId}`,
			type: 'signal',
			dispatchId: input.dispatchId,
			messageId: inputEntryId,
			parentId: null,
			signalType: 'test.event',
			content: 'Hello',
		},
	]);
	await executionStore.submissions.markSubmissionInputApplied(
		{ submissionId: input.dispatchId, attemptId },
		options.durability ?? { maxRetry: 1, timeoutAt: Date.now() + 60_000 },
	);

	if (options.shape === 'ghost-start' || options.shape === 'ghost-stream') {
		const records: ConversationRecord[] = [
			{
				...scope,
				id: 'record-stream-started',
				type: 'assistant_message_started',
				messageId: 'entry_stream_partial',
				parentId: inputEntryId,
				modelInfo: { api: 'faux', provider: 'faux', model: 'reviewer' },
			},
		];
		if (options.shape === 'ghost-stream') records.push(
			{
				...scope,
				id: 'record-stream-text-started',
				type: 'assistant_text_started',
				messageId: 'entry_stream_partial',
				blockId: 'block-stream',
				blockIndex: 0,
			},
			{
				...scope,
				id: 'record-stream-delta',
				type: 'assistant_text_delta',
				messageId: 'entry_stream_partial',
				blockId: 'block-stream',
				sequence: 0,
				delta: 'Durable partial',
			},
		);
		await append(records);
		return { conversationId };
	}

	const toolCalls =
		options.shape === 'task-call'
			? [{ id: 'task-call-1', name: 'task', arguments: { prompt: 'Delegate.', agent: 'reviewer' } }]
			: [
					{ id: 'tool-call-1', name: 'lookup', arguments: {} },
					{ id: 'tool-call-2', name: 'lookup', arguments: {} },
				];
	await append([
		{
			...scope,
			id: 'record-tool-started',
			type: 'assistant_message_started',
			messageId: 'entry_tool_assistant',
			parentId: inputEntryId,
			modelInfo: { api: 'faux', provider: 'faux', model: 'reviewer' },
		},
		...toolCalls.map((toolCall, index) => ({
			...scope,
			id: `record-tool-call-${index}`,
			type: 'assistant_tool_call' as const,
			messageId: 'entry_tool_assistant',
			blockId: `block-tool-${index}`,
			blockIndex: index,
			toolCallId: toolCall.id,
			name: toolCall.name,
			arguments: toolCall.arguments,
		})),
		{
			...scope,
			id: 'record-tool-completed',
			type: 'assistant_message_completed',
			messageId: 'entry_tool_assistant',
			stopReason: 'toolUse',
			usage,
		},
	]);

	if (options.shape === 'partial-batch') {
		await append([
			{
				...scope,
				id: 'record-tool-outcome-1',
				type: 'tool_outcome',
				assistantMessageId: 'entry_tool_assistant',
				toolCallId: 'tool-call-1',
				toolName: 'lookup',
				isError: false,
				content: [{ type: 'text', text: 'Known completed result' }],
			},
		]);
		return { conversationId };
	}

	// task-call: retained child conversation, no outcome recorded.
	const taskId = '00000000-0000-4000-8000-000000000001';
	const childConversationId = `conversation-child-${options.dispatchId}`;
	const childSession = `task:default:${taskId}`;
	await append([
		{
			v: 1,
			id: 'record-child-created',
			type: 'conversation_created',
			kind: 'task',
			conversationId: childConversationId,
			harness: 'default',
			session: childSession,
			timestamp,
			affinityKey: generateSessionAffinityKey(),
			createdAt: timestamp,
			parentConversationId: conversationId,
			taskId,
			agent: 'reviewer',
		},
		{
			v: 1,
			id: 'record-child-retained',
			type: 'child_session_retained',
			conversationId,
			harness: 'default',
			session: 'default',
			timestamp,
			child: {
				type: 'task',
				conversationId: childConversationId,
				harness: 'default',
				session: childSession,
				taskId,
				parentToolCallId: 'task-call-1',
				parentAssistantEntryId: 'entry_tool_assistant',
			},
		},
	]);
	return { conversationId, childConversationId };
}

async function readCanonicalRecords(dbPath: string): Promise<ConversationRecord[]> {
	const adapter = sqlite(dbPath);
	await adapter.migrate?.();
	const { conversationStreamStore } = await adapter.connect();
	const read = await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1'));
	return read.batches.flatMap((batch) => batch.records);
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
			message: {
				kind: 'signal',
				type: 'custom.event',
				body: '<value>&first</value>',
				attributes: { source: 'test' },
			},
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
			signalType: 'custom.event',
			content: '<value>&first</value>',
			attributes: { source: 'test' },
		});
		expect(providerMessages).toEqual([[
			'<signal type="custom.event" source="test">\n&lt;value&gt;&amp;first&lt;/value&gt;\n</signal>',
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

	describe('cancellation', () => {
		it('aborts queued work for an instance before the provider runs, recording an abort advisory', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			// One head-of-line dispatch blocks on a gate so a second dispatch to
			// the same instance stays queued. Aborting the instance must settle the
			// queued one without ever invoking its provider response.
			let releaseGate!: () => void;
			const gate = new Promise<void>((resolve) => {
				releaseGate = resolve;
			});
			let signalBlockerStarted!: () => void;
			const blockerStarted = new Promise<void>((resolve) => {
				signalBlockerStarted = resolve;
			});
			const providerCalls: string[] = [];
			provider.setResponses([
				async () => {
					providerCalls.push('blocker');
					signalBlockerStarted();
					await gate;
					return fauxAssistantMessage('Blocker done.');
				},
				async () => {
					providerCalls.push('target-should-not-run');
					return fauxAssistantMessage('Should not happen.');
				},
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'abort-blocker' }));
			// Wait until the blocker is genuinely inside its provider call (past its
			// own pre-execution abort check) so the abort can't pre-empt it instead.
			await blockerStarted;
			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'abort-target' }));

			// The target is head-of-line blocked behind the running blocker.
			expect(await executionStore.submissions.getSubmission('abort-target')).toMatchObject({
				status: 'queued',
			});

			expect(await coordinator.abortInstance('assistant', 'instance-1')).toBe(true);

			releaseGate();
			await coordinator.waitForIdle();

			// The queued target never reached its provider response.
			expect(providerCalls).toEqual(['blocker']);
			expect(await executionStore.submissions.getSubmission('abort-target')).toMatchObject({
				status: 'settled',
			});

			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { conversationStreamStore } = await adapter.connect();
			const read = await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1'));
			const records = read.batches.flatMap((batch) => batch.records);
			const aborted = records.find(
				(record) =>
					record.type === 'signal' &&
					record.signalType === 'submission_aborted' &&
					record.attributes?.submissionId === 'abort-target',
			);
			expect(aborted).toBeDefined();

			await coordinator.shutdown();
		});

		it('reports nothing to abort when the instance has only settled work', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'abort-late' }));
			await coordinator.waitForIdle();

			expect(await coordinator.abortInstance('assistant', 'instance-1')).toBe(false);

			await coordinator.shutdown();
		});

		it('reports nothing to abort for an instance with no submissions', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Done.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			expect(await coordinator.abortInstance('assistant', 'never-used-instance')).toBe(false);

			await coordinator.shutdown();
		});
	});

	// These tests fork a fresh Node process that loads the full runtime bundle
	// and performs SQLite I/O on both the child and the reconciling parent. The
	// 5s default test timeout is too tight under the CPU contention of the full
	// parallel suite (the cause of intermittent timeouts here); give generous
	// headroom. A real hang would still fail at this ceiling.
	describe('interrupt and recover', { timeout: 30_000 }, () => {
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

		it('terminalizes an input-only assistant start before running the replacement attempt', async () => {
			const dbPath = createTempDbPath();
			await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-input-only-start',
				shape: 'ghost-start',
				durability: { maxRetry: 2, timeoutAt: Date.now() + 60_000 },
			});
			let providerCalls = 0;
			const provider = createFauxProvider();
			provider.setResponses([
				() => {
					providerCalls += 1;
					return fauxAssistantMessage('Recovered after interruption.');
				},
				() => {
					providerCalls += 1;
					return fauxAssistantMessage('Follow-up reply.');
				},
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			expect(providerCalls).toBe(1);
			expect(
				await executionStore.submissions.getSubmission('dispatch-input-only-start'),
			).toMatchObject({ status: 'settled' });
			let records = await readCanonicalRecords(dbPath);
			expect(records.find((record) => record.id === 'record_recovery_entry_stream_partial_aborted'))
				.toMatchObject({ type: 'assistant_message_completed', stopReason: 'aborted' });

			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-after-recovery' }));
			await coordinator.waitForIdle();

			expect(providerCalls).toBe(2);
			expect(await executionStore.submissions.getSubmission('dispatch-after-recovery')).toMatchObject({
				status: 'settled',
			});
			records = await readCanonicalRecords(dbPath);
			expect(records.some((record) => record.submissionId === 'dispatch-after-recovery')).toBe(true);
			await coordinator.shutdown();
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

		// Canonical #378 scenario, end to end: a real process kill mid subagent
		// tool-work, recovered by a real coordinator. The parent must reattach and
		// resume its in-flight child, resolve the task call from the child's real
		// result, and never re-run the child's interrupted tool.
		it('resumes an interrupted subagent and resolves the parent task call after a real process kill', async () => {
			const dbPath = createTempDbPath();
			await killAtDurableBoundary('child-tool-repair', dbPath);
			const adapter = sqlite(dbPath);
			await adapter.migrate?.();
			const { executionStore, conversationStreamStore, attachmentStore } = await adapter.connect();
			const provider = createFauxProvider();
			provider.setResponses([
				fauxAssistantMessage('Child finished the delegated work.'),
				fauxAssistantMessage('Parent done with the delegated result.'),
			]);
			let childToolRuns = 0;
			const lookup = defineTool({
				name: 'lookup',
				description: 'Look up.',
				input: v.object({}),
				run: async () => {
					childToolRuns += 1;
					return 'must not run';
				},
			});
			const model = `${provider.getModel().provider}/${provider.getModel().id}`;
			const coordinator = createNodeAgentCoordinator({
				submissions: executionStore.submissions,
				agents: [{
					name: 'assistant',
					definition: defineAgent(() => ({
						model,
						subagents: [{ name: 'reviewer', model, tools: [lookup] }],
					})),
				}],
				createContext: makeFauxCreateContext(provider),
				conversationStreamStore,
				attachmentStore,
			});

			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			// The child's interrupted tool was never re-run.
			expect(childToolRuns).toBe(0);
			const records = (await conversationStreamStore.read(agentStreamPath('assistant', 'instance-1')))
				.batches.flatMap((batch) => batch.records);
			// The parent's task call resolved from the real child result, not a marker.
			const taskOutcome = records.find(
				(record) => record.type === 'tool_outcome' && record.toolCallId === 'task-call-1',
			);
			expect(taskOutcome).toMatchObject({
				toolName: 'task',
				isError: false,
				content: [{ type: 'text', text: 'Child finished the delegated work.' }],
			});
			// The child's interrupted lookup got a single interrupted marker.
			const childOutcome = records.find(
				(record) => record.type === 'tool_outcome' && record.toolCallId === 'child-lookup-1',
			);
			expect(childOutcome).toMatchObject({ toolCallId: 'child-lookup-1', isError: true });
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
						signalType: 'test.event',
						content: 'Hello',
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

	describe('terminal settlement', { timeout: 30_000 }, () => {
		it('settles an unresolved task call with an interrupted marker when the retry budget is exhausted', async () => {
			const dbPath = createTempDbPath();
			const { childConversationId } = await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-exhausted-task',
				shape: 'task-call',
			});
			const provider = createFauxProvider();
			let providerCalls = 0;
			provider.setResponses([
				() => {
					providerCalls += 1;
					return fauxAssistantMessage('Must not run.');
				},
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);

			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			// Exhaustion settles without any provider work: no model call, no
			// child resume.
			expect(providerCalls).toBe(0);
			const submission = await executionStore.submissions.getSubmission('dispatch-exhausted-task');
			expect(submission).toMatchObject({ status: 'settled' });
			expect(submission?.error).toBeDefined();

			const records = await readCanonicalRecords(dbPath);
			// The task call has a terminal outcome linking the retained child.
			const outcome = records.find(
				(record) => record.type === 'tool_outcome' && record.toolCallId === 'task-call-1',
			);
			expect(outcome).toMatchObject({ toolName: 'task', isError: true });
			const outcomeText =
				outcome?.type === 'tool_outcome' && outcome.content[0]?.type === 'text'
					? JSON.parse(outcome.content[0].text)
					: undefined;
			expect(outcomeText).toMatchObject({
				type: 'interrupted',
				childConversationId,
			});
			expect(records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(1);
			// The retained child link is untouched.
			expect(records.some((record) => record.type === 'child_session_retained')).toBe(true);
			// The advisory carries the structured interrupted-call list.
			const advisory = records.find(
				(record) =>
					record.type === 'signal' &&
					record.signalType === 'submission_interrupted' &&
					record.attributes?.submissionId === 'dispatch-exhausted-task',
			);
			expect(advisory).toBeDefined();
			if (advisory?.type !== 'signal') throw new Error('Expected signal advisory.');
			expect(advisory.attributes?.reason).toBe('exhausted_retry_budget');
			expect(JSON.parse(advisory.attributes?.interruptedTools ?? '[]')).toEqual([
				{ name: 'task', id: 'task-call-1' },
			]);
			await coordinator.shutdown();
		});

		it('preserves recorded outcomes and keeps the settled turn visible to the next submission', async () => {
			const dbPath = createTempDbPath();
			await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-exhausted-batch',
				shape: 'partial-batch',
			});
			const provider = createFauxProvider();
			const { coordinator } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			const records = await readCanonicalRecords(dbPath);
			const outcomes = records.filter((record) => record.type === 'tool_outcome');
			expect(outcomes).toHaveLength(2);
			expect(outcomes[0]).toMatchObject({
				toolCallId: 'tool-call-1',
				isError: false,
				content: [{ type: 'text', text: 'Known completed result' }],
			});
			expect(outcomes[1]).toMatchObject({ toolCallId: 'tool-call-2', isError: true });
			expect(records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(1);

			// Silent-erasure regression: the settled turn is included in the model
			// context of the NEXT submission (an unsettled batch would be dropped).
			let capturedContext = '';
			provider.setResponses([
				(context) => {
					capturedContext = JSON.stringify(context.messages);
					return fauxAssistantMessage('Follow-up reply.');
				},
			]);
			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-follow-up' }));
			await coordinator.waitForIdle();
			expect(capturedContext).toContain('tool-call-1');
			expect(capturedContext).toContain('Known completed result');
			expect(capturedContext).toContain('tool-call-2');
			expect(capturedContext).toContain('interrupted');
			await coordinator.shutdown();
		});

		it('materializes a ghost in-progress stream as aborted without resumption signals', async () => {
			const dbPath = createTempDbPath();
			await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-exhausted-stream',
				shape: 'ghost-stream',
			});
			const provider = createFauxProvider();
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			expect(
				await executionStore.submissions.getSubmission('dispatch-exhausted-stream'),
			).toMatchObject({ status: 'settled' });
			const records = await readCanonicalRecords(dbPath);
			// The in-progress stream was completed as aborted...
			expect(
				records.find((record) => record.id === 'record_recovery_entry_stream_partial_block-stream_completed'),
			).toBeDefined();
			expect(
				records.find((record) => record.id === 'record_recovery_entry_stream_partial_aborted'),
			).toMatchObject({ type: 'assistant_message_completed', stopReason: 'aborted' });
			// ...without inviting resumption.
			expect(
				records.some(
					(record) =>
						record.type === 'signal' &&
						(record.signalType === 'stream_interrupted' || record.signalType === 'stream_continued'),
				),
			).toBe(false);
			// The advisory has no interrupted tools (none were pending).
			const advisory = records.find(
				(record) => record.type === 'signal' && record.signalType === 'submission_interrupted',
			);
			expect(advisory).toBeDefined();
			if (advisory?.type !== 'signal') throw new Error('Expected signal advisory.');
			expect(advisory.attributes?.interruptedTools).toBeUndefined();
			await coordinator.shutdown();
		});

		it('marker-settles the trailing batch when terminalized by timeout', async () => {
			const dbPath = createTempDbPath();
			await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-timeout-task',
				shape: 'task-call',
				durability: { maxRetry: 5, timeoutAt: Date.now() - 1_000 },
			});
			const provider = createFauxProvider();
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			expect(await executionStore.submissions.getSubmission('dispatch-timeout-task')).toMatchObject(
				{ status: 'settled' },
			);
			const records = await readCanonicalRecords(dbPath);
			expect(
				records.find((record) => record.type === 'tool_outcome' && record.toolCallId === 'task-call-1'),
			).toMatchObject({ toolName: 'task', isError: true });
			const advisory = records.find(
				(record) => record.type === 'signal' && record.signalType === 'submission_interrupted',
			);
			if (advisory?.type !== 'signal') throw new Error('Expected signal advisory.');
			expect(advisory.attributes?.reason).toBe('exceeded_timeout');
			expect(JSON.parse(advisory.attributes?.interruptedTools ?? '[]')).toEqual([
				{ name: 'task', id: 'task-call-1' },
			]);
			await coordinator.shutdown();
		});

		it('marker-settles the trailing batch when a crash-interrupted submission is aborted', async () => {
			const dbPath = createTempDbPath();
			await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-aborted-batch',
				shape: 'partial-batch',
				durability: { maxRetry: 5, timeoutAt: Date.now() + 60_000 },
			});
			const provider = createFauxProvider();
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			expect(await coordinator.abortInstance('assistant', 'instance-1')).toBe(true);
			await coordinator.reconcileSubmissions();
			await coordinator.waitForIdle();

			expect(
				await executionStore.submissions.getSubmission('dispatch-aborted-batch'),
			).toMatchObject({ status: 'settled' });
			const records = await readCanonicalRecords(dbPath);
			expect(
				records.find((record) => record.type === 'tool_outcome' && record.toolCallId === 'tool-call-2'),
			).toMatchObject({ isError: true });
			expect(records.filter((record) => record.type === 'tool_results_committed')).toHaveLength(1);
			const advisory = records.find(
				(record) => record.type === 'signal' && record.signalType === 'submission_aborted',
			);
			expect(advisory).toBeDefined();
			if (advisory?.type !== 'signal') throw new Error('Expected signal advisory.');
			expect(JSON.parse(advisory.attributes?.interruptedTools ?? '[]')).toEqual([
				{ name: 'lookup', id: 'tool-call-2' },
			]);
			await coordinator.shutdown();
		});

		it('self-heals a conversation left dangling by an already-settled submission on the next input', async () => {
			const dbPath = createTempDbPath();
			// Pre-fix damage: the submission settled without settling its
			// conversation (terminal paths used to skip repair entirely).
			await seedDanglingSubmission({
				dbPath,
				dispatchId: 'dispatch-damaged',
				shape: 'partial-batch',
				durability: { maxRetry: 5, timeoutAt: Date.now() + 60_000 },
			});
			const store = await openExecutionStore(dbPath);
			await store.submissions.failSubmission(
				{ submissionId: 'dispatch-damaged', attemptId: 'attempt-dispatch-damaged' },
				new Error('pre-fix damage'),
			);

			const provider = createFauxProvider();
			let capturedContext = '';
			provider.setResponses([
				(context) => {
					capturedContext = JSON.stringify(context.messages);
					return fauxAssistantMessage('Healed reply.');
				},
			]);
			const { coordinator, executionStore } = await createFauxCoordinator(dbPath, provider);
			await coordinator.admitDispatch(makeDispatchInput({ dispatchId: 'dispatch-healer' }));
			await coordinator.waitForIdle();

			expect(await executionStore.submissions.getSubmission('dispatch-healer')).toMatchObject({
				status: 'settled',
			});
			const records = await readCanonicalRecords(dbPath);
			// The abandoned batch was settled before the new input extended the leaf.
			const commitIndex = records.findIndex((record) => record.type === 'tool_results_committed');
			const healerInputIndex = records.findIndex(
				(record) => record.id === 'record_dispatch_input_dispatch-healer',
			);
			expect(commitIndex).toBeGreaterThan(-1);
			expect(healerInputIndex).toBeGreaterThan(-1);
			expect(commitIndex).toBeLessThan(healerInputIndex);
			// And the repaired turn is visible to the healer's model context.
			expect(capturedContext).toContain('Known completed result');
			expect(capturedContext).toContain('tool-call-2');
			await coordinator.shutdown();
		});
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
					makeDispatchInput({
						dispatchId: 'dispatch-conflict',
						message: { kind: 'signal', type: 'test.event', body: 'Different' },
					}),
				),
			).rejects.toThrow();
			await coordinator.waitForIdle();
		});
	});

	// ─── Direct prompt admission ────────────────────────────────────────────

		describe('direct prompt admission', () => {
		it('materializes the canonical conversation before admission returns', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Later reply.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const receipt = await coordinator
				.createAdmission('assistant', 'instance-1')({ kind: 'user', body: 'Hello' });
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
			const receipt = await admit({ kind: 'user', body: 'Hello from direct prompt' });

			expect(receipt.submissionId).toEqual(expect.any(String));
			// Admission is fire-and-forget; wait for the durable lifecycle to settle.
			await coordinator.waitForIdle();
			// The submission should be settled in the store.
			expect(await executionStore.submissions.hasUnsettledSubmissions()).toBe(false);
			const settled = await executionStore.submissions.getSubmission(receipt.submissionId);
			expect(settled?.status).toBe('settled');
			expect(settled?.error).toBeUndefined();
		});

		it('persists direct prompt submission across store reopens', async () => {
			const dbPath = createTempDbPath();
			const provider = createFauxProvider();
			provider.setResponses([fauxAssistantMessage('Persisted direct reply.')]);
			const { coordinator } = await createFauxCoordinator(dbPath, provider);

			const admit = coordinator.createAdmission('assistant', 'instance-1');
			await admit({ kind: 'user', body: 'Hello persisted' });
			// Admission is fire-and-forget; wait for the durable lifecycle to settle.
			await coordinator.waitForIdle();

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
				kind: 'user',
				body: 'Hello from direct prompt',
			});
			// Admission is fire-and-forget; the user message is persisted during
			// processing, so wait for the durable lifecycle to settle before reading.
			await coordinator.waitForIdle();

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
				admit({ kind: 'user', body: 'First' }),
				admit({ kind: 'user', body: 'Second' }),
			]);

			// Both should resolve (not reject).
			expect(result1).toBeDefined();
			expect(result2).toBeDefined();
			// Admission is fire-and-forget; wait for both to settle durably.
			await coordinator.waitForIdle();
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
				message: { kind: 'user', body: 'Hello interrupted' },
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
				message: { kind: 'user', body: 'Hello terminalized' },
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
				message: { kind: 'user', body: 'Direct first' },
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
