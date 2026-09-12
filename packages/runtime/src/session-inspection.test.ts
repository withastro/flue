import { expect, it, vi } from 'vitest';
import { encodeCanonicalId } from './conversation-records.ts';
import { ConversationRecordWriter } from './conversation-writer.ts';
import { sqlite } from './node/agent-execution-store.ts';
import type { AgentSubmissionInput } from './runtime/agent-submissions.ts';
import { generateAttemptId, generateRecordId, generateSubmissionId } from './runtime/ids.ts';
import { agentStreamPath } from './runtime/stream-offsets.ts';
import { Session } from './session.ts';

it('returns the existing inspection offset without another stream read or a guessed tool count', async () => {
	const persistence = sqlite();
	await persistence.migrate?.();
	const stores = await persistence.connect();
	let session: Session | undefined;
	try {
		const writer = await ConversationRecordWriter.create({
			store: stores.conversationStreamStore,
			path: agentStreamPath('InspectionAgent', 'test'),
			identity: { agentName: 'InspectionAgent', instanceId: 'test' },
			producerId: 'test-producer',
		});
		const scope = { conversationId: 'test-conversation', harness: 'default', session: 'default' };
		await writer.ensureConversation({
			...scope,
			kind: 'root',
			affinityKey: 'test-affinity',
			createdAt: new Date().toISOString(),
		});
		const conversation = await writer.getConversation(scope.conversationId);
		if (!conversation) throw new Error('Test conversation is missing');
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
					id: 'test-model',
					name: 'Test model',
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
		const input: AgentSubmissionInput = {
			kind: 'direct',
			submissionId: generateSubmissionId(),
			agent: 'InspectionAgent',
			id: 'test',
			message: { kind: 'user', body: 'Test input' },
			acceptedAt: new Date().toISOString(),
		};
		const read = vi.spyOn(stores.conversationStreamStore, 'read');
		const getConversation = vi.spyOn(writer, 'getConversation');
		const initialOffset = writer.offset;
		expect(await session.inspectSubmissionInput(input)).toEqual({
			state: 'absent',
			position: { lastStreamOffset: initialOffset, pendingToolCount: null },
		});
		await stores.submissionStore.admitDirect(input);
		await stores.submissionStore.markSubmissionCanonicalReady(input.submissionId);
		const attempt = { submissionId: input.submissionId, attemptId: generateAttemptId() };
		await stores.submissionStore.claimSubmission({
			...attempt,
			ownerId: 'test-producer',
			leaseExpiresAt: Date.now() + 60_000,
		});
		const appended = await writer.append(
			[
				{
					...scope,
					v: 1,
					id: generateRecordId(),
					type: 'user_message',
					timestamp: new Date().toISOString(),
					submissionId: input.submissionId,
					attemptId: attempt.attemptId,
					messageId: `entry_direct_${encodeCanonicalId(input.submissionId)}`,
					parentId: null,
					content: [{ type: 'text', text: input.message.body }],
				},
			],
			{ submission: attempt },
		);
		expect(appended.offset).not.toBe(initialOffset);
		expect(await session.inspectSubmissionInput(input)).toEqual({
			state: 'interrupted',
			position: { lastStreamOffset: appended.offset, pendingToolCount: null },
		});
		expect(getConversation).toHaveBeenCalledTimes(2);
		expect(read).not.toHaveBeenCalled();
	} finally {
		await session?.close();
		await persistence.close?.();
		vi.restoreAllMocks();
	}
});
