import { afterEach, expect, it, vi } from 'vitest';
import { createFlueContext } from '../client.ts';
import { type ConversationRecord, encodeCanonicalId } from '../conversation-records.ts';
import { getActiveConversationPath } from '../conversation-reducer.ts';
import { ConversationRecordWriter } from '../conversation-writer.ts';
import type { Harness } from '../harness.ts';
import { observe } from '../index.ts';
import { sqlite } from '../node/agent-execution-store.ts';
import { Session } from '../session.ts';
import type { FlueObservation } from '../types.ts';
import { type AgentSubmissionInput, reconcileInterruptedSubmission } from './agent-submissions.ts';
import { createCoordinatorEventEmitter, drainGlobalEventDeliveries } from './events.ts';
import { generateAttemptId, generateSubmissionId } from './ids.ts';
import { agentStreamPath } from './stream-offsets.ts';

afterEach(() => vi.useRealTimers());

it('preserves real transcripts, pending tool results, attempts, and settlement with reporting on or off', async () => {
	vi.useFakeTimers({ toFake: ['Date'] });
	vi.setSystemTime(new Date('2026-09-12T00:00:00Z'));
	const input: AgentSubmissionInput = {
		kind: 'direct',
		submissionId: generateSubmissionId(),
		agent: 'RecoveryAgent',
		id: 'retained',
		message: { kind: 'user', body: 'Local pending tool test' },
		acceptedAt: new Date().toISOString(),
	};
	const attempt = { submissionId: input.submissionId, attemptId: generateAttemptId() };
	async function recover(reporting: boolean) {
		const persistence = sqlite();
		await persistence.migrate?.();
		const stores = await persistence.connect();
		let session: Session | undefined;
		const events: FlueObservation[] = [];
		const stop = reporting
			? observe((event) => {
					events.push(event);
				})
			: () => {};
		try {
			await stores.submissionStore.admitDirect(input);
			await stores.submissionStore.markSubmissionCanonicalReady(input.submissionId);
			await stores.submissionStore.claimSubmission({
				...attempt,
				ownerId: 'test-producer',
				leaseExpiresAt: Date.now() + 60_000,
			});
			await stores.submissionStore.markSubmissionInputApplied(attempt, {
				maxAttempts: 1,
				timeoutAt: Date.now() + 60_000,
			});
			let reads = 0;
			// Keep the real SQL stream and count reads through its injected interface.
			const stream = new Proxy(stores.conversationStreamStore, {
				get(target, key) {
					const value = Reflect.get(target, key);
					if (typeof value !== 'function') return value;
					return (...args: unknown[]) => {
						if (key === 'read') reads++;
						return Reflect.apply(value, target, args);
					};
				},
			});
			const writer = await ConversationRecordWriter.create({
				store: stream,
				path: agentStreamPath(input.agent, input.id),
				identity: { agentName: input.agent, instanceId: input.id },
				producerId: 'test-producer',
			});
			const scope = { conversationId: 'test-conversation', harness: 'default', session: 'default' };
			await writer.ensureConversation({
				...scope,
				kind: 'root',
				affinityKey: 'test',
				createdAt: new Date().toISOString(),
			});
			const envelope = { ...scope, v: 1 as const, timestamp: new Date().toISOString(), ...attempt };
			const inputId = `entry_direct_${encodeCanonicalId(input.submissionId)}`;
			const records: ConversationRecord[] = [
				{
					...envelope,
					id: 'record_input',
					type: 'user_message',
					messageId: inputId,
					parentId: null,
					content: [{ type: 'text', text: input.message.body }],
				},
				{
					...envelope,
					id: 'record_assistant',
					type: 'assistant_message_started',
					messageId: 'entry_assistant',
					parentId: inputId,
					modelInfo: { api: 'openai-completions', provider: 'test', model: 'local-model' },
				},
				{
					...envelope,
					id: 'record_tool',
					type: 'assistant_tool_call',
					messageId: 'entry_assistant',
					blockId: 'tool-block',
					blockIndex: 0,
					toolCallId: 'pending-call',
					name: 'local_tool',
					arguments: {},
				},
				{
					...envelope,
					id: 'record_complete',
					type: 'assistant_message_completed',
					messageId: 'entry_assistant',
					stopReason: 'toolUse',
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				},
			];
			await writer.append(records, { submission: attempt });
			const conversation = await writer.getConversation(scope.conversationId);
			if (!conversation) throw new Error('Missing retained test conversation');
			expect(conversation.toolOutcomes.size).toBe(0);
			expect(
				getActiveConversationPath(conversation).some(
					(entry) =>
						entry.type === 'message' &&
						entry.message.role === 'assistant' &&
						entry.message.content.some(
							(block) => block.type === 'toolCall' && block.id === 'pending-call',
						),
				),
			).toBe(true);
			session = new Session({
				name: 'default',
				conversation,
				conversationWriter: writer,
				attachmentStore: stores.attachmentStore,
				envSlot: { env: undefined, toolFactory: undefined, rediscoverNeeded: false },
				config: {
					systemPrompt: '',
					skills: {},
					resolveModel: () => undefined,
					model: {
						id: 'local-model',
						name: 'Local model',
						api: 'openai-completions',
						provider: 'test',
						baseUrl: 'https://unused.invalid',
						reasoning: false,
						input: ['text'],
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						contextWindow: 8192,
						maxTokens: 100,
					},
				},
			});
			const realSession = session;
			const createContext = () => {
				const ctx = createFlueContext({
					id: input.id,
					agentName: input.agent,
					submissionId: input.submissionId,
					env: {},
					agentConfig: { resolveModel: () => undefined },
				});
				// SAFETY: The session handler supports a directly injected internal Session.
				ctx.initializeRootHarness = async () =>
					({ session: async () => realSession }) as unknown as Harness;
				return ctx;
			};
			const row = await stores.submissionStore.getSubmission(input.submissionId);
			if (!row) throw new Error('Missing retained test submission');
			const offset = writer.offset;
			const readsBefore = reads;
			await reconcileInterruptedSubmission(
				stores.submissionStore,
				row,
				() => 'Local test',
				createContext,
				undefined,
				writer,
				reporting ? createCoordinatorEventEmitter({ env: {} }) : undefined,
			);
			await drainGlobalEventDeliveries();
			const readsDuringRecovery = reads - readsBefore;
			const settled = await stores.submissionStore.getSubmission(input.submissionId);
			const reduced = await writer.getConversation(scope.conversationId);
			if (!reduced) throw new Error('Missing settled test conversation');
			const transcript = getActiveConversationPath(reduced).flatMap((entry) =>
				entry.type === 'message' ? [entry.message] : [],
			);
			expect(transcript).toContainEqual(
				expect.objectContaining({ role: 'toolResult', toolCallId: 'pending-call', isError: true }),
			);
			expect(reduced.toolOutcomes.size).toBe(0);
			expect(settled?.status).toBe('settled');
			expect(settled?.attemptCount).toBe(1);
			expect(await stores.submissionStore.listPendingSubmissionSettlements()).toEqual([]);
			if (reporting) {
				expect(events.filter((event) => event.type === 'submission_recovery_decision')).toEqual([
					expect.objectContaining({
						reason: 'retry_exhausted',
						position: { lastStreamOffset: offset, pendingToolCount: null },
						error: null,
					}),
				]);
			}
			return {
				transcript,
				attemptId: settled?.attemptId,
				count: settled?.attemptCount,
				status: settled?.status,
				error: settled?.error,
				readsDuringRecovery,
			};
		} finally {
			stop();
			await session?.close();
			await persistence.close?.();
		}
	}
	const disabled = await recover(false);
	const enabled = await recover(true);
	expect(enabled).toEqual(disabled);
	expect(enabled.readsDuringRecovery).toBe(0);
});
